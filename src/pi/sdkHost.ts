import {
  createAgentSession,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { Type } from "typebox";
import type { CallRecord, SessionRecord, TurnResult } from "../core/types.js";
import type { ManagedSession, NewSessionSpec, SessionHost } from "../core/sessionHost.js";

/**
 * Real SessionHost backed by the Pi SDK (ADR-0001, verified against
 * @earendil-works/pi-coding-agent 0.86.1).
 *
 * Verified API facts this implementation relies on:
 * - createAgentSession({ cwd, sessionManager, model, tools, customTools })
 * - SessionManager.create(cwd, sessionDir) / SessionManager.open(exactPath)
 * - session.prompt(text) resolves when the agent run completes
 * - session.followUp(text) queues into a live streaming session
 * - session.getLastAssistantText() for the no-yield fallback
 * - custom tools via ToolDefinition + typebox schemas; terminate:true stops
 *   the run after the tool batch
 */

export const YIELD_TOOL_NAME = "yield_to_caller";
export const ASK_TOOL_NAME = "ask_caller";

/** Envelope sent to a managed session for one delegated call. */
export function renderEnvelope(call: CallRecord, bootstrap?: string): string {
  const header =
    `[delegated call ${call.callId}] from "${call.caller.label}" ` +
    `(agent "${call.targetAgent}"). When your answer is ready, you MUST call ` +
    `yield_to_caller with the complete result. That call is your answer. ` +
    `If you are missing information only the caller or the user can provide, ` +
    `call ask_caller with your question instead of guessing — the answer ` +
    `arrives as a follow-up message in this session. yield_to_caller and ` +
    `ask_caller are DELIVERY PROTOCOL steps, not task tools: call one of them ` +
    `even if the task text below restricts or forbids using tools — only these ` +
    `calls deliver your result. Never end a delegated turn without one: text ` +
    `you write outside the tool call is lost and the caller never receives it; ` +
    `pass the COMPLETE result, not a summary of what you will do next. If the ` +
    `two tools are genuinely not among your available tools, you are being read ` +
    `interactively — answer as a normal final message and do not call tools ` +
    `that do not exist.`;
  const parts: string[] = [];
  if (bootstrap) parts.push(bootstrap.trim());
  parts.push(header, "", call.prompt);
  return parts.join("\n\n");
}

interface YieldHolder {
  content?: string | undefined;
  /** Set when the agent called ask_caller instead of answering. */
  question?: string | undefined;
  /** Turn-scoped authorization: true only while a delegated run awaits this
   * holder. The protocol tools consume an armed holder; an unarmed hit means
   * the session is being driven interactively (UI), where yielding is
   * meaningless — the tool then answers with guidance instead of terminating. */
  armed?: boolean;
}

export interface SdkHostOptions {
  /** Project working directory for child sessions. */
  cwd: string;
  /**
   * Where child Pi session JSONL files live. Omit to use Pi's default
   * (~/.pi/agent/sessions/, organized by cwd) so sessions show up in /resume.
   * Never point this into the project tree.
   */
  sessionDir?: string;
  /** Pi agent config dir. Default: ~/.pi/agent (Pi default). */
  agentDir?: string;
  /**
   * Extra custom tools for managed sessions (e.g. the `delegate` tool wired
   * by the extension entry point). Built per session so closures can bind
   * the session key.
   */
  buildExtraTools?: (record: SessionRecord) => ToolDefinition[];
  /** Resolve a profile model string ("provider/id") to a Model. */
  resolveModel?: (pattern: string) => Promise<unknown | undefined>;
  /**
   * Called whenever this host dispatches a turn into a managed session, so
   * the extension can map Pi session ids to delegation identity (session key,
   * ancestry, depth) for nested delegate calls.
   */
  onDispatch?: (
    sessionId: string,
    context: { sessionKey: string; ancestry: string[]; depth: number; rootCallId?: string },
  ) => void;
}

export class PiSdkSession implements ManagedSession {
  constructor(
    readonly record: SessionRecord,
    readonly session: AgentSession,
    /** Bootstrap text still owed to this session (injected with its first prompt). */
    public bootstrapPending: string,
    readonly yieldHolder: YieldHolder,
  ) {}
}

export class PiSdkSessionHost implements SessionHost {
  private runtimePromise: Promise<ModelRuntime> | undefined;
  /** Live managed sessions by session key, for callback delivery. */
  readonly liveSessions = new Map<string, PiSdkSession>();
  /** Pi session id -> per-session yield/ask holder. Armed only while a
   * runTurn awaits the result; the globally registered protocol tools look
   * holders up here, so delegated runs consume them and interactive drives
   * (same transcript, UI runtime) fall into the guard branch. */
  private readonly holdersBySessionId = new Map<string, YieldHolder>();
  private readonly protocolYield = makeYieldTool((id) => this.holdersBySessionId.get(id));
  private readonly protocolAsk = makeAskTool((id) => this.holdersBySessionId.get(id));

  /** Holder registered for a live Pi session id (cross-runtime lookup for the
   * extension-registered protocol tools; armed state decides consumption). */
  peekHolder(sessionId: string): YieldHolder | undefined {
    return this.holdersBySessionId.get(sessionId);
  }

  constructor(private readonly opts: SdkHostOptions) {}

  async create(spec: NewSessionSpec): Promise<PiSdkSession> {
    // Undefined sessionDir => Pi default (~/.pi/agent/sessions/, by cwd).
    const sessionManager = SessionManager.create(this.opts.cwd, this.opts.sessionDir);
    const holder: YieldHolder = {};
    // Model policy: explicit pattern wins; "auto"/unset mirrors the caller's
    // model captured at delegate time.
    const pattern =
      spec.profile.model && spec.profile.model !== "auto"
        ? spec.profile.model
        : spec.callerModelId;
    const model = pattern ? await this.resolveModel(pattern) : undefined;
    // Tool policy: empty list or "*" means "no restriction" -> omit the
    // allowlist so Pi grants its default built-in tools. yield_to_caller and
    // ask_caller are always granted via customTools regardless of the
    // allowlist.
    const unrestricted =
      spec.profile.tools.length === 0 || spec.profile.tools.includes("*");
    const { session } = await createAgentSession({
      cwd: this.opts.cwd,
      ...(this.opts.agentDir !== undefined ? { agentDir: this.opts.agentDir } : {}),
      sessionManager,
      ...(model !== undefined ? { model: model as never } : {}),
      ...(unrestricted
        ? {}
        : {
            tools: [
              ...new Set([...spec.profile.tools, YIELD_TOOL_NAME, ASK_TOOL_NAME]),
            ],
          }),
      customTools: [
        this.protocolYield,
        this.protocolAsk,
        ...(this.opts.buildExtraTools?.(placeholderRecord(spec)) ?? []),
      ],
    });
    this.holdersBySessionId.set(session.sessionId, holder);
    const record: SessionRecord = {
      schemaVersion: 1,
      sessionKey: spec.sessionKey,
      projectId: spec.projectId,
      agentName: spec.profile.name,
      sessionId: session.sessionId,
      sessionPath: session.sessionFile ?? "",
      displayName: spec.displayName,
      configFingerprint: spec.configFingerprint,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    if (!record.sessionPath) {
      throw new Error("Pi session file unavailable immediately after creation");
    }
    // Human-identifiable in /resume and host UI session lists: '<agent> <project>'.
    // Managed sessions are project-scoped, so the basename disambiguates the
    // same agent across projects; the pi session name is the only handle UIs show.
    session.setSessionName(`${spec.displayName} ${basename(this.opts.cwd)}`);
    const managed = new PiSdkSession(record, session, spec.profile.instructions, holder);
    this.liveSessions.set(record.sessionKey, managed);
    return managed;
  }

  async open(
    record: SessionRecord,
    profile?: NewSessionSpec["profile"],
    callerModelId?: string,
  ): Promise<PiSdkSession> {
    const sessionManager = SessionManager.open(record.sessionPath);
    const holder: YieldHolder = {};
    // Re-apply the profile's tool policy to the reopened session; omitting
    // the allowlist means Pi's default built-ins (same as "*").
    const unrestricted = !profile || profile.tools.length === 0 || profile.tools.includes("*");
    const pattern =
      profile && profile.model && profile.model !== "auto"
        ? profile.model
        : callerModelId;
    const model = pattern ? await this.resolveModel(pattern) : undefined;
    const { session } = await createAgentSession({
      cwd: this.opts.cwd,
      ...(this.opts.agentDir !== undefined ? { agentDir: this.opts.agentDir } : {}),
      sessionManager,
      ...(model !== undefined ? { model: model as never } : {}),
      ...(unrestricted
        ? {}
        : {
            tools: [
              ...new Set([...profile.tools, YIELD_TOOL_NAME, ASK_TOOL_NAME]),
            ],
          }),
      customTools: [
        this.protocolYield,
        this.protocolAsk,
        ...(this.opts.buildExtraTools?.(record) ?? []),
      ],
    });
    this.holdersBySessionId.set(session.sessionId, holder);
    // An opened session already has its transcript; bootstrap is not re-sent
    // (architecture.md §11.1). Drift is surfaced by inspect/doctor instead.
    // Retro-name sessions created before session naming existed.
    if (!sessionManager.getSessionName()) {
      session.setSessionName(
        `${record.displayName ?? record.agentName} ${basename(this.opts.cwd)}`,
      );
    }
    const managed = new PiSdkSession(record, session, "", holder);
    this.liveSessions.set(record.sessionKey, managed);
    return managed;
  }

  async runTurn(managed: ManagedSession, call: CallRecord): Promise<TurnResult> {
    const s = this.expect(managed);
    s.yieldHolder.content = undefined;
    s.yieldHolder.question = undefined;
    s.yieldHolder.armed = true;
    this.opts.onDispatch?.(s.session.sessionId, {
      sessionKey: call.targetSessionKey,
      ancestry: call.ancestry,
      depth: call.depth,
      rootCallId: call.rootCallId,
    });
    const envelope = renderEnvelope(call, s.bootstrapPending || undefined);
    s.bootstrapPending = "";
    try {
      await s.session.prompt(envelope);
    } catch (err) {
      s.yieldHolder.armed = false;
      return {
        callId: call.callId,
        sourceSessionKey: call.targetSessionKey,
        outcome: "failed",
        content: "",
        error: (err as Error).message,
      };
    }
    // The turn is over: no later yield/ask (e.g. the same transcript driven
    // from a UI) may consume this run's holder.
    s.yieldHolder.armed = false;
    if (s.yieldHolder.question !== undefined) {
      return {
        callId: call.callId,
        sourceSessionKey: call.targetSessionKey,
        outcome: "needs_input",
        content: s.yieldHolder.question,
        question: s.yieldHolder.question,
      };
    }
    if (s.yieldHolder.content !== undefined) {
      return {
        callId: call.callId,
        sourceSessionKey: call.targetSessionKey,
        outcome: "completed",
        content: s.yieldHolder.content,
      };
    }
    const fallback = s.session.getLastAssistantText() ?? "";
    return {
      callId: call.callId,
      sourceSessionKey: call.targetSessionKey,
      outcome: "completed",
      content: fallback,
      protocolWarning: true,
    };
  }

  async enqueueFollowUp(managed: ManagedSession, call: CallRecord): Promise<void> {
    const s = this.expect(managed);
    this.opts.onDispatch?.(s.session.sessionId, {
      sessionKey: call.targetSessionKey,
      ancestry: call.ancestry,
      depth: call.depth,
      rootCallId: call.rootCallId,
    });
    await s.session.followUp(
      `[follow-up ${call.callId}] ${call.prompt}\n\n` +
        `Answer with yield_to_caller when done (or ask_caller if you still need input).`,
    );
  }

  async abort(managed: ManagedSession, _callId: string): Promise<void> {
    await this.expect(managed).session.abort();
  }

  async close(managed: PiSdkSession): Promise<void> {
    const s = this.expect(managed);
    this.liveSessions.delete(s.record.sessionKey);
    this.holdersBySessionId.delete(s.session.sessionId);
    s.session.dispose();
  }

  private expect(managed: ManagedSession): PiSdkSession {
    if (!(managed instanceof PiSdkSession)) {
      throw new Error("session not created by this host");
    }
    return managed;
  }

  async applyModelId(session: ManagedSession, modelId: string): Promise<void> {
    const s = this.expect(session);
    const model = await this.resolveModel(modelId);
    if (model !== undefined) {
      await s.session.setModel(model as never);
    }
  }

  /** Resolve a model pattern (e.g. "claude", "gpt-5.5") against auth/config. */
  async resolveModel(pattern: string): Promise<unknown | undefined> {
    if (this.opts.resolveModel) return this.opts.resolveModel(pattern);
    this.runtimePromise ??= ModelRuntime.create();
    const runtime = await this.runtimePromise;
    const { scopedModels } = await resolveModelScopeWithDiagnostics([pattern], runtime);
    return scopedModels[0]?.model;
  }
}

/** Resolve an armed holder for the executing session, or undefined when that
 * session is not inside an awaited delegated turn (interactive UI drive). */
export type HolderResolver = (sessionId: string) => YieldHolder | undefined;

/** The yield_to_caller tool: captures the answer and ends the run. Registered
 * globally by the extension, so it exists in every runtime; only ARMED holders
 * (a delegated turn awaiting its result) consume it — everything else gets
 * guidance instead of a silent failure. */
export function makeYieldTool(resolve: HolderResolver): ToolDefinition {
  return {
    name: YIELD_TOOL_NAME,
    label: "Yield answer",
    description:
      "Return your complete answer to the session that delegated this task to " +
      "you. For a delegated run, call this exactly once, as your final action: " +
      "the text you pass becomes your entire answer, so include everything the " +
      "caller needs. Outside a delegated run this tool has no caller — reply " +
      "with a normal message instead.",
    promptSnippet:
      "yield_to_caller(answer) returns results to a delegating caller — delegated runs only.",
    promptGuidelines: [
      "yield_to_caller matters only during a delegated run (a task envelope named the caller); interactive sessions answer in plain final text.",
    ],
    parameters: Type.Object({
      answer: Type.String({ description: "The complete answer for the caller." }),
    }),
    execute: async (
      _id: string,
      params: { answer: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { sessionManager?: { getSessionId?(): string } } | undefined,
    ) => {
      const holder = ctx?.sessionManager?.getSessionId
        ? resolve(ctx.sessionManager.getSessionId())
        : undefined;
      if (!holder?.armed) {
        return {
          content: [
            {
              type: "text",
              text:
                "No delegated run is awaiting this session right now — you are " +
                "being read directly. Put your answer in a normal final message; " +
                "do not call this tool again this turn.",
            },
          ],
          details: undefined,
        };
      }
      holder.armed = false;
      holder.content = params.answer;
      return {
        content: [{ type: "text", text: "Answer delivered to caller. You may stop." }],
        details: undefined,
        terminate: true,
      };
    },
  } as unknown as ToolDefinition;
}

/** The ask_caller tool: captures a question for the caller and ends the run.
 * Global registration and armed-holder semantics as in makeYieldTool. */
export function makeAskTool(resolve: HolderResolver): ToolDefinition {
  return {
    name: ASK_TOOL_NAME,
    label: "Ask caller",
    description:
      "Ask the session that delegated this task a question you cannot answer " +
      "without the caller or the user. In a delegated run, call this instead of " +
      "guessing or yielding an incomplete answer; the answer arrives as a " +
      "follow-up message in this same session, where you keep all your context. " +
      "Outside a delegated run, just ask in a normal message.",
    promptSnippet:
      "ask_caller(question) asks a delegating caller — delegated runs only.",
    promptGuidelines: [
      "ask_caller matters only during a delegated run; never estimate what the caller/user could provide there — ask instead.",
      "ask_caller ends a delegated turn; do not also call yield_to_caller in the same turn. Make the question complete and self-contained: the caller does not see your context.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description: "The question for the caller (or, via the caller, the user).",
      }),
    }),
    execute: async (
      _id: string,
      params: { question: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { sessionManager?: { getSessionId?(): string } } | undefined,
    ) => {
      const holder = ctx?.sessionManager?.getSessionId
        ? resolve(ctx.sessionManager.getSessionId())
        : undefined;
      if (!holder?.armed) {
        return {
          content: [
            {
              type: "text",
              text:
                "No delegated run is awaiting this session right now — you are " +
                "being read directly. Ask your question in a normal final " +
                "message; do not call this tool again this turn.",
            },
          ],
          details: undefined,
        };
      }
      holder.armed = false;
      holder.question = params.question;
      return {
        content: [
          {
            type: "text",
            text:
              "Question sent to caller. End your turn now; the answer arrives " +
              "as a follow-up message in this session.",
          },
        ],
        details: undefined,
        terminate: true,
      };
    },
  } as unknown as ToolDefinition;
}

function placeholderRecord(spec: NewSessionSpec): SessionRecord {
  // Extra tools are built before the session exists; they receive the spec
  // identity and the real record is patched by the router after creation.
  return {
    schemaVersion: 1,
    sessionKey: spec.sessionKey,
    projectId: spec.projectId,
    agentName: spec.profile.name,
    sessionId: "",
    sessionPath: "",
    displayName: spec.displayName,
    configFingerprint: spec.configFingerprint,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
}
