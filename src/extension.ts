import fs from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { canonicalProjectId, buildSessionKey } from "./core/keys.js";
import { CallStore } from "./core/callStore.js";
import { MailboxRegistry } from "./core/mailbox.js";
import { ProfileStore } from "./core/profileStore.js";
import { SessionRegistry } from "./core/registry.js";
import { DelegationRouter, renderCallback, type CallbackDeliverer } from "./core/router.js";
import type { CallerAddress } from "./core/types.js";
import { makeAskTool, makeYieldTool, PiSdkSessionHost } from "./pi/sdkHost.js";

/**
 * Pi extension entry point (architecture.md §5, §8-§10).
 *
 * One router per process: managed child sessions run in-process, so their
 * extension instances (loaded by Pi's normal discovery) share the singleton
 * and can delegate to each other through the same router and stores.
 */

const DELEGATE_TOOL = "delegate";
const LIST_AGENTS_TOOL = "list_agents";
const CALLBACK_TYPE = "delegation_result";

interface Services {
  cwd: string;
  projectId: string;
  stateDir: string;
  profiles: ProfileStore;
  registry: SessionRegistry;
  calls: CallStore;
  mailboxes: MailboxRegistry;
  host: PiSdkSessionHost;
  router: DelegationRouter;
  /** Root sessions live in THIS process, keyed by exact Pi session id.
   * Root callbacks route strictly by caller.sessionId — never "whoever
   * registered last": a single shared slot let a session that started later
   * (e.g. a managed child opened in a UI) steal callbacks addressed to its
   * caller and self-confirm delivery into its own transcript (observed
   * 2026-09-22, pi-web daemon). */
  liveRoots: Map<string, { api: ExtensionAPI; sessionFile: string | undefined }>;
  /** Caller identity per live session id, recorded when the router dispatches. */
  callerContext: Map<
    string,
    { sessionKey: string; ancestry: string[]; depth: number; rootCallId?: string }
  >;
  /** callId -> last send attempt; blocks re-queue until confirm() or cooldown. */
  inFlight: Map<string, number>;
}

/** Re-send an unconfirmed callback only after this long (visible duplicate is
 * better than a lost callback; confirm() normally clears inFlight first). */
const REDRIVE_COOLDOWN_MS = 30_000;

/**
 * Services per project cwd — NOT process.cwd(). A long-lived host process
 * (e.g. the pi-web session daemon, WORKDIR /app in Docker) serves sessions
 * whose cwd differs from its own; project identity, child-session cwd, and
 * the projectId hash must come from the *session's* cwd (ctx.cwd), never
 * from the host process working directory.
 */
const servicesByCwd = new Map<string, Services>();

function getStateDir(): string {
  return process.env.PI_SUBAGENTS_STATE_DIR ?? path.join(getAgentDir(), "subagents");
}

function getServices(cwd: string): Services {
  const key = path.resolve(cwd);
  const existing = servicesByCwd.get(key);
  if (existing) return existing;
  const stateDir = getStateDir();
  const projectId = canonicalProjectId(key);
  const profiles = new ProfileStore({
    userProfilesFile: path.join(stateDir, "profiles.yaml"),
    // User-owned profile directory (NOT the project): a cloned repository can
    // never define or rewrite an agent persona. Override with
    // PI_SUBAGENTS_AGENTS_DIR.
    agentsDir:
      process.env.PI_SUBAGENTS_AGENTS_DIR ??
      path.join(path.dirname(getAgentDir()), "agents"),
  });
  const registry = new SessionRegistry(stateDir);
  const calls = new CallStore(stateDir);
  const mailboxes = new MailboxRegistry();

  const svc = {} as Services;
  const deliverer: CallbackDeliverer = {
    // Both paths are fire-and-forget from our perspective (Pi queues and
    // persists asynchronously), so we return false and let confirm() verify
    // durable evidence before marking delivered.
    async deliver(caller: CallerAddress, message: string, callId: string): Promise<boolean> {
      const last = svc.inFlight.get(callId);
      if (last !== undefined && Date.now() - last < REDRIVE_COOLDOWN_MS) {
        return false; // already queued this process-lifetime; await confirm
      }
      svc.inFlight.set(callId, Date.now());
      if (caller.kind === "root") {
        const target = svc.liveRoots.get(caller.sessionId);
        if (!target) return false; // caller not live in this process: stays pending
        target.api.sendMessage(
          {
            customType: CALLBACK_TYPE,
            content: message,
            display: true,
            details: { caller: caller.label },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        return false;
      }
      const live = svc.host.liveSessions.get(caller.sessionKey ?? "");
      if (!live) return false; // managed caller closed: stays pending
      await live.session.sendCustomMessage(
        { customType: CALLBACK_TYPE, content: message, display: true, details: {} },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      return false;
    },
    async confirm(callId: string, caller: CallerAddress): Promise<boolean> {
      const file = await transcriptFor(svc, caller);
      if (!file) return false;
      try {
        const raw = await fs.readFile(file, "utf8");
        // The receipt tool result also mentions the callId and the literal
        // "delegation_result", so a file-global includes() check false-positives
        // as soon as a session has *any* delivered callback (marker) plus any
        // queued call (receipt callId). Require BOTH within the SAME persisted
        // custom_message entry — the actual durable artifact of a delivery.
        const found = raw.split("\n").some((line) => {
          if (!line.includes(callId) || !line.includes(CALLBACK_TYPE)) return false;
          try {
            const e = JSON.parse(line);
            return (
              e?.type === "custom_message" &&
              e?.customType === CALLBACK_TYPE &&
              JSON.stringify(e).includes(callId)
            );
          } catch {
            return false;
          }
        });
        if (found) svc.inFlight.delete(callId);
        return found;
      } catch {
        return false;
      }
    },
  };

  const host = new PiSdkSessionHost({
    cwd: key,
    // Default: Pi's own session dir (~/.pi/agent/sessions/, organized by cwd)
    // so managed sessions are visible in /resume. Override with
    // PI_SUBAGENTS_SESSION_DIR to isolate them elsewhere.
    ...(process.env.PI_SUBAGENTS_SESSION_DIR
      ? { sessionDir: process.env.PI_SUBAGENTS_SESSION_DIR }
      : {}),
    onDispatch: (sessionId, ctx) => svc.callerContext.set(sessionId, ctx),
    // Managed sessions get delegate/list_agents too, so agents can talk to
    // each other (nested delegation). execute() resolves the caller from the
    // per-session ExtensionContext, so one shared instance serves all sessions.
    buildExtraTools: () => [makeDelegateTool(), makeListAgentsTool()],
  });
  const router = new DelegationRouter({ projectId, profiles, registry, calls, mailboxes, host, deliverer });

  // Populate the SAME object the deliverer closure captured above.
  svc.cwd = key;
  svc.projectId = projectId;
  svc.stateDir = stateDir;
  svc.profiles = profiles;
  svc.registry = registry;
  svc.calls = calls;
  svc.mailboxes = mailboxes;
  svc.host = host;
  svc.router = router;
  svc.liveRoots = new Map();
  svc.callerContext = new Map();
  svc.inFlight = new Map();
  servicesByCwd.set(key, svc);
  return svc;
}

/** Locate the caller's transcript file for delivery confirmation. */
async function transcriptFor(
  svc: Services,
  caller: CallerAddress,
): Promise<string | undefined> {
  if (caller.kind === "root") {
    return svc.liveRoots.get(caller.sessionId)?.sessionFile;
  }
  const live = caller.sessionKey ? svc.host.liveSessions.get(caller.sessionKey) : undefined;
  if (live?.record.sessionPath) return live.record.sessionPath;
  const record = caller.sessionKey ? await svc.registry.get(caller.sessionKey) : undefined;
  return record?.sessionPath;
}

/** delegate tool, shared between the root session and managed sessions.
 * Resolves services from the *calling session's* cwd at execute time. */
function makeDelegateTool(): ToolDefinition {
  return defineTool({
    name: DELEGATE_TOOL,
    label: "Delegate to agent",
    description:
      "Fire-and-forget delegation to a persistent named agent session. Use for " +
      "web research beyond a single known-URL fetch (multi-source research, " +
      "comparisons, verification), second-pair-of-eyes review/analysis of any " +
      "target (projects and folders, but also research, plans, event concepts, " +
      "designs, documents), and " +
      "other deep background work. Returns a " +
      "receipt immediately; the agent's answer arrives later as a " +
      "delegation_result message. Use list_agents to see available agents.",
    promptSnippet:
      "delegate(agent, prompt) sends a task to a persistent agent session and returns a receipt; the answer arrives later as a delegation_result message.",
    promptGuidelines: [
      "delegate is asynchronous: after calling it, keep working or tell the user you delegated; do not wait or poll for the answer.",
      "When a delegation_result message arrives, treat it as the agent's full answer and continue your task with it.",
      "When a delegation_question message arrives, the agent is blocked waiting: answer it yourself if you can, otherwise ask the user, then reply by delegating to the same agent again (the agent continues in its same session with full context).",
      "Delegate web research to the 'research' agent: anything beyond a single known-URL fetch belongs there — multi-source research, comparisons, fact verification, version/API lookups, or any question needing several searches/reads to answer fully.",
      "Delegate EVERY user request to review, analyze, or audit SOMETHING — a project, folder, or codebase, but equally research, plans, itineraries, event/party concepts, designs, or documents — to the 'review' agent: it is the fresh-context second pair of eyes, always delegate rather than reviewing inline; pass the target (path, file, or subject description) and any focus the user mentioned. The review agent keeps memory of previous reviews.",
      "Do not do multi-step web research yourself; use your own web tools only for one quick fetch of a URL you already know.",
      "Delegate deep codebase investigations and other long-running background work too — the agent keeps memory across calls, so repeated tasks on the same topic get cheaper.",
      "Make each delegated prompt self-contained: the agent only sees this prompt plus its own past sessions, never this conversation.",
      "The delegated prompt must contain the TASK ONLY: never forbid or restrict tool use (e.g. 'do not use tools') — the agent delivers its result via the yield_to_caller tool call, so tool restrictions in the prompt collide with the delivery protocol and degrade delivery to a fallback. Keep output-length/format wishes in the prompt; keep tool policy out of it.",
      "Write delegated prompts in English regardless of the language the user is speaking — managed agents think and respond in English by design; translating the task into the agent's working language is part of preparing a self-contained prompt.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Agent profile name, e.g. 'research'." }),
      prompt: Type.String({
        description:
          "The complete task for the agent. Task content only — do not forbid or " +
          "restrict tool use; the agent must call yield_to_caller (a tool) to deliver.",
      }),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const svc = getServices(ctx.cwd);
      const caller = resolveCaller(svc, ctx);
      const receipt = await svc.router.delegate(
        { agent: params.agent, prompt: params.prompt },
        caller,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        details: receipt,
      };
    },
  });
}

/** list_agents tool, shared between the root session and managed sessions. */
function makeListAgentsTool(): ToolDefinition {
  return defineTool({
    name: LIST_AGENTS_TOOL,
    label: "List agents",
    description:
      "List the agent profiles available for delegation, with descriptions " +
      "and last-used times.",
    promptSnippet: "list_agents() shows which named agents can be delegated to.",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      const svc = getServices(ctx.cwd);
      const [profiles, sessions] = await Promise.all([
        svc.profiles.list(),
        svc.registry.list(),
      ]);
      const lines = profiles.map((p) => {
        const record = sessions.find((s) => s.sessionKey === buildSessionKey(svc.projectId, p.name));
        const last = record ? ` (last used ${record.lastUsedAt})` : " (not started yet)";
        return `- ${p.name}: ${p.description || "(no description)"}${last}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") || "(no agent profiles defined)" }],
        details: { count: profiles.length },
      };
    },
  });
}

export default function persistentSubagents(pi: ExtensionAPI): void {
  // NOTE: never bind services to process.cwd() here — the host process cwd
  // (e.g. /app in a Docker daemon) is not the session cwd. Everything is
  // resolved from ctx.cwd at use time.
  // Protocol tools are registered GLOBALLY (single source; the SDK host no
  // longer injects its own copies) so they exist in every runtime the
  // extension loads into — including a managed transcript opened in a UI.
  // Consumption is holder-armed: only a delegated run awaiting its result
  // consumes the call; anything else gets an interactive-guidance result.
  const resolveHolder = (sessionId: string) => {
    for (const s of servicesByCwd.values()) {
      const holder = s.host.peekHolder(sessionId);
      if (holder) return holder;
    }
    return undefined;
  };
  pi.registerTool(makeYieldTool(resolveHolder));
  pi.registerTool(makeAskTool(resolveHolder));

  pi.registerTool(makeDelegateTool());
  pi.registerTool(makeListAgentsTool());

  pi.registerCommand("subagents", {
    description:
      "Inspect persistent subagent sessions (overview, doctor, reset <agent>, model <agent> [pattern|default])",
    handler: async (args, ctx) => {
      const svc = getServices(ctx.cwd);
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] ?? "";
      if (sub === "model") {
        // /subagents model <agent> [pattern|auto]
        const name = parts[1];
        const rawPattern = parts[2];
        const pattern = rawPattern === "default" ? "auto" : rawPattern;
        if (!name) {
          ctx.ui.notify(
            "usage: /subagents model <agent> [pattern|auto] — no pattern shows the current model; auto (default) mirrors the calling agent's model",
            "warning",
          );
          return;
        }
        const profile = await svc.profiles.get(name);
        if (!profile) {
          ctx.ui.notify(`subagents model: no profile "${name}"`, "warning");
          return;
        }
        if (!pattern) {
          const live = svc.host.liveSessions.get(buildSessionKey(svc.projectId, profile.name));
          const current = live?.session.model;
          ctx.ui.notify(
            `subagents model ${profile.name}: profile=${profile.model ?? "auto (mirrors caller)"}${
              current ? `  live=${String(current.id ?? "?")}` : "  live=(no session running)"
            }`,
            "info",
          );
          return;
        }
        // Validate the pattern resolves before touching the profile.
        const resolved = pattern === "auto" ? undefined : await svc.host.resolveModel(pattern);
        if (pattern !== "auto" && resolved === undefined) {
          ctx.ui.notify(
            `subagents model: pattern "${pattern}" did not resolve to any available model.`,
            "error",
          );
          return;
        }
        await svc.profiles.set({
          name: profile.name,
          description: profile.description,
          bootstrap: profile.instructions,
          tools: profile.tools,
          ...(pattern === "auto" ? { model: "auto" } : { model: pattern }),
        });
        // Apply immediately to a live session so the next turn uses it.
        const live = svc.host.liveSessions.get(buildSessionKey(svc.projectId, profile.name));
        if (live && resolved) {
          try {
            await live.session.setModel(resolved as never);
            ctx.ui.notify(
              `subagents model ${profile.name}: set to "${pattern}" (applied to the live session too).`,
              "info",
            );
          } catch (err) {
            ctx.ui.notify(
              `subagents model ${profile.name}: saved to profile, but live switch failed: ${String(err)}. It applies on the next session open.`,
              "warning",
            );
          }
        } else {
          ctx.ui.notify(
            pattern === "auto"
              ? `subagents model ${profile.name}: auto — each delegation mirrors the calling agent's model.`
              : `subagents model ${profile.name}: saved "${pattern}" to the profile (applies on next session open).`,
            "info",
          );
        }
        return;
      }
      if (sub === "reset") {
        const name = parts[1];
        if (!name) {
          ctx.ui.notify("usage: /subagents reset <agent>", "warning");
          return;
        }
        const key = buildSessionKey(svc.projectId, name);
        const record = await svc.registry.get(key);
        const live = svc.host.liveSessions.get(key);
        if (live) {
          try {
            await live.session.abort();
          } catch {
            /* best effort */
          }
          await svc.host.close(live);
        }
        const removed = await svc.registry.remove(key);
        if (record && existsSync(record.sessionPath)) {
          try {
            rmSync(record.sessionPath);
          } catch (err) {
            ctx.ui.notify(
              `subagents reset ${name}: session closed, but transcript delete failed: ${String(err)}`,
              "error",
            );
            return;
          }
        }
        ctx.ui.notify(
          removed
            ? `subagents reset ${name}: session closed, transcript deleted — next delegation starts fresh (bootstrap re-injected).`
            : `subagents reset ${name}: no session registered for "${name}" (nothing to reset).`,
          removed ? "info" : "warning",
        );
        return;
      }
      if (sub === "doctor") {
        const report = await svc.registry.doctor();
        ctx.ui.notify(
          report.ok
            ? "subagents doctor: OK"
            : `subagents doctor issues:\n${report.issues.map((i) => `- ${i.sessionKey}: ${i.problem}`).join("\n")}`,
          report.ok ? "info" : "warning",
        );
        return;
      }
      // Default: overview.
      const [sessions, pending] = await Promise.all([
        svc.registry.list(),
        svc.calls.pendingCallbacks(),
      ]);
      const all = await svc.calls.list();
      const active = all.filter((c) => c.status === "queued" || c.status === "running");
      const lines = [
        `project: ${svc.projectId}  state: ${svc.stateDir}`,
        sessions.length
          ? `sessions:\n${sessions.map((s) => `- ${s.agentName}  ${s.sessionPath}  (last ${s.lastUsedAt})`).join("\n")}`
          : "sessions: none yet",
        active.length ? `active calls:\n${active.map((c) => `- ${c.callId.slice(0, 8)} ${c.targetAgent} [${c.status}]`).join("\n")}` : "active calls: none",
        pending.length ? `undelivered callbacks: ${pending.length}` : "callbacks: all delivered",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const svc = getServices(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    svc.liveRoots.set(sessionId, {
      api: pi,
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
    });
    // Recover interrupted calls, then flush ONLY callbacks addressed to
    // THIS session (plus managed ones) — never everybody's pending at once.
    const { recovered, delivered } = await svc.router.reconcile({
      rootSessionId: sessionId,
    });
    if (recovered || delivered) {
      pi.sendMessage(
        {
          customType: CALLBACK_TYPE,
          content:
            `subagents: recovered ${recovered} interrupted call(s), ` +
            `delivered ${delivered} pending callback(s).`,
          display: true,
          details: {},
        },
        { deliverAs: "nextTurn" },
      );
    }
  });

  // Drop the live handle on shutdown so callbacks addressed to this session
  // stay pending (redriven at its next start) instead of being injected into
  // a dead runtime.
  pi.on("session_shutdown", async (_event, ctx) => {
    getServices(ctx.cwd).liveRoots.delete(ctx.sessionManager.getSessionId());
  });

  // Retry callbacks that arrived while the addressee was not attached. Scoped
  // to the settling session: whichever runtime settles next must NOT deliver
  // (and self-confirm) callbacks addressed to someone else.
  pi.on("agent_settled", async (_event, ctx) => {
    await getServices(ctx.cwd).router.flushOutbox({
      rootSessionId: ctx.sessionManager.getSessionId(),
    });
  });
}

/** Identify the caller of the delegate tool from the extension context. */
function resolveCaller(
  svc: Services,
  ctx: ExtensionContext,
): {
  address: CallerAddress;
  sessionKey?: string;
  ancestry: string[];
  depth: number;
  rootCallId?: string;
  callerModelId?: string;
} {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  const callerModelId = ctx.model?.id;
  const known = svc.callerContext.get(sessionId);
  if (known) {
    return {
      address: { kind: "managed", sessionId, sessionKey: known.sessionKey, label: known.sessionKey },
      sessionKey: known.sessionKey,
      ancestry: known.ancestry,
      depth: known.depth,
      ...(known.rootCallId !== undefined ? { rootCallId: known.rootCallId } : {}),
      ...(callerModelId !== undefined ? { callerModelId } : {}),
    };
  }
  if (sessionFile) {
    // A managed session resumed after a restart: callerContext is empty, but
    // the registry still identifies it. Reconstruct a minimal identity.
    const record = findRecordByPathSyncHint(svc, sessionFile);
    if (record) {
      return {
        address: { kind: "managed", sessionId, sessionKey: record.sessionKey, label: record.agentName },
        sessionKey: record.sessionKey,
        ancestry: [record.sessionKey],
        depth: 1,
        ...(callerModelId !== undefined ? { callerModelId } : {}),
      };
    }
  }
  return {
    address: { kind: "root", sessionId, label: "main" },
    ancestry: [],
    depth: 0,
    ...(callerModelId !== undefined ? { callerModelId } : {}),
  };
}

function findRecordByPathSyncHint(svc: Services, sessionFile: string) {
  // Registry reads are async; resolveCaller is sync, so callers awaiting
  // execute() tolerate this small race: we check the live host map first.
  for (const [key, live] of svc.host.liveSessions) {
    if (live.record.sessionPath === sessionFile) {
      return { sessionKey: key, agentName: live.record.agentName };
    }
  }
  return undefined;
}

export { renderCallback };
