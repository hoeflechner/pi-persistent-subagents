import { randomUUID } from "node:crypto";
import { buildSessionKey, parseSessionKey } from "./keys.js";
import type { CallStore } from "./callStore.js";
import type { SessionRegistry } from "./registry.js";
import type { ProfileStore } from "./profileStore.js";
import type { MailboxRegistry } from "./mailbox.js";
import type { ManagedSession, SessionHost } from "./sessionHost.js";
import {
  type AgentProfile,
  type CallRecord,
  type CallerAddress,
  type DelegateRequest,
  type DelegationReceipt,
  type TurnResult,
} from "./types.js";

/**
 * Delegation router (architecture.md §8-§10).
 *
 * delegate() is fire-and-forget: it persists a call record, enqueues work on
 * the target's FIFO mailbox, and returns a receipt immediately. When the
 * turn settles, a callback is durably queued and delivered to the immediate
 * caller via the CallbackDeliverer.
 */

export const MAX_DEPTH = 8;

/** Injects a delegation_result message into a caller session. */
export interface CallbackDeliverer {
  /** Returns true only when delivery is CONFIRMED (e.g. persisted in the
   * caller transcript). Returns false when merely queued or unreachable;
   * the item stays pending until confirm() or a later flush verifies it. */
  deliver(caller: CallerAddress, message: string, callId: string): Promise<boolean>;
  /**
   * Optional: check durable evidence that the callback already landed
   * (e.g. the callId appears in the caller's session file). Called by
   * flushOutbox before re-sending, to keep at-least-once from becoming
   * at-least-twice-visible.
   */
  confirm?(callId: string, caller: CallerAddress): Promise<boolean>;
}

export interface RouterDeps {
  projectId: string;
  profiles: ProfileStore;
  registry: SessionRegistry;
  calls: CallStore;
  mailboxes: MailboxRegistry;
  host: SessionHost;
  deliverer: CallbackDeliverer;
  now?: () => Date;
}

export class DelegationRouter {
  private readonly liveSessions = new Map<string, ManagedSession>();
  private readonly now: () => Date;

  constructor(private readonly deps: RouterDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Register a session that is already live in the host. The extension layer
   * calls this when a managed session starts, so same-key follow-ups reuse it
   * instead of opening a second handle.
   */
  registerLiveSession(session: ManagedSession): void {
    this.liveSessions.set(session.record.sessionKey, session);
  }

  forgetLiveSession(sessionKey: string): void {
    this.liveSessions.delete(sessionKey);
  }

  /** Entry point for the delegate tool. Never blocks on the delegated turn. */
  async delegate(
    request: DelegateRequest,
    caller: {
      address: CallerAddress;
      sessionKey?: string;
      ancestry: string[];
      depth: number;
      rootCallId?: string;
      /** Model id the caller is running; mirrored by "auto" profiles. */
      callerModelId?: string;
    },
  ): Promise<DelegationReceipt> {
    const profile = await this.deps.profiles.get(request.agent);
    if (!profile) {
      throw new UnknownAgentError(request.agent, await this.deps.profiles.list());
    }

    const targetKey = buildSessionKey(this.deps.projectId, profile.name);
    const nowIso = this.now().toISOString();
    const callId = randomUUID();
    const rootCallId = caller.rootCallId ?? callId;

    // 1. Same key as the caller's own session => local follow-up, no new session.
    if (caller.sessionKey === targetKey) {
      const record: CallRecord = {
        callId,
        rootCallId,
        status: "queued",
        targetSessionKey: targetKey,
        targetAgent: profile.name,
        caller: caller.address,
        prompt: request.prompt,
        ancestry: caller.ancestry,
        depth: caller.depth,
        createdAt: nowIso,
        localFollowUp: true,
      };
      await this.deps.calls.create(record);
      // The caller IS this session, so it must already be live.
      const session = this.liveSessions.get(targetKey) ?? (await this.ensureSession(profile, targetKey));
      this.deps.mailboxes
        .for(targetKey)
        .push(async () => this.runLocalFollowUp(session, record));
      return {
        kind: "local_follow_up",
        callId,
        targetAgent: profile.name,
        status: "queued",
        message:
          `Queued as a follow-up in your own session (${profile.name}). ` +
          `You will process it when your current turn finishes; no separate reply will be sent.`,
      };
    }

    // 2. Cross-agent cycle: target key already in causal ancestry => reject.
    if (caller.ancestry.includes(targetKey)) {
      const record: CallRecord = {
        callId,
        rootCallId,
        status: "cycle_rejected",
        targetSessionKey: targetKey,
        targetAgent: profile.name,
        caller: caller.address,
        prompt: request.prompt,
        ancestry: caller.ancestry,
        depth: caller.depth,
        createdAt: nowIso,
        settledAt: nowIso,
        summary:
          `Delegation to "${profile.name}" was rejected: it appears in the causal ` +
          `ancestry (${caller.ancestry.join(" -> ")} -> ${targetKey}). ` +
          `Answer from your own context or delegate to a different agent.`,
      };
      await this.deps.calls.create(record);
      // The rejection itself is a callback so the caller learns promptly.
      await this.tryDeliver(record, {
        callId,
        sourceSessionKey: targetKey,
        outcome: "cycle_rejected",
        content: record.summary ?? "cycle rejected",
      });
      return {
        kind: "delegation_receipt",
        callId,
        targetAgent: profile.name,
        status: "cycle_rejected",
        message: record.summary ?? "cycle rejected",
      };
    }

    // 3. Depth guard.
    if (caller.depth + 1 > MAX_DEPTH) {
      throw new DepthLimitError(MAX_DEPTH);
    }

    // 4. Normal cross-session delegation: persist, enqueue, receipt.
    const record: CallRecord = {
      callId,
      rootCallId,
      status: "queued",
      targetSessionKey: targetKey,
      targetAgent: profile.name,
      caller: caller.address,
      prompt: request.prompt,
      ancestry: [...caller.ancestry, caller.sessionKey ?? "root"],
      depth: caller.depth + 1,
      createdAt: nowIso,
      ...(caller.callerModelId !== undefined ? { callerModelId: caller.callerModelId } : {}),
    };
    await this.deps.calls.create(record);
    const session = await this.ensureSession(profile, targetKey, caller.callerModelId);
    this.deps.mailboxes
      .for(targetKey)
      .push(async () => this.runDelegatedTurn(session, record));

    return {
      kind: "delegation_receipt",
      callId,
      targetAgent: profile.name,
      status: "queued",
      message:
        `Delegated to "${profile.name}" (call ${callId}). The result will arrive in ` +
        `this chat as a delegation_result message when it settles. You may keep working.`,
    };
  }

  /** Deliver every settled-but-undelivered callback (startup + retries).
   * Confirms previously-queued deliveries first so retries do not duplicate. */
  async flushOutbox(): Promise<number> {
    const pending = await this.deps.calls.pendingCallbacks();
    let delivered = 0;
    for (const call of pending) {
      if (this.deps.deliverer.confirm) {
        const confirmed = await this.deps.deliverer
          .confirm(call.callId, call.caller)
          .catch(() => false);
        if (confirmed) {
          await this.deps.calls.markDelivered(call.callId);
          delivered++;
          continue;
        }
      }
      const message = renderCallback(call);
      const ok = await this.deps.deliverer.deliver(call.caller, message, call.callId);
      if (!ok) continue; // caller closed; retry on next flush
      await this.deps.calls.markDelivered(call.callId);
      delivered++;
    }
    return delivered;
  }

  /** Startup: recover interrupted calls, then flush their callbacks. */
  async reconcile(): Promise<{ recovered: number; delivered: number }> {
    const recovered = await this.deps.calls.recoverInterrupted();
    const delivered = await this.flushOutbox();
    return { recovered: recovered.length, delivered };
  }

  private async ensureSession(
    profile: AgentProfile,
    sessionKey: string,
    callerModelId?: string,
  ): Promise<ManagedSession> {
    const live = this.liveSessions.get(sessionKey);
    if (live) return live;

    const existing = await this.deps.registry.get(sessionKey);
    if (existing) {
      const session = await this.deps.host.open(existing, profile, callerModelId);
      this.liveSessions.set(sessionKey, session);
      await this.deps.registry.touch(sessionKey, this.now().toISOString());
      return session;
    }

    const created = await this.deps.host.create({
      sessionKey,
      projectId: this.deps.projectId,
      profile,
      displayName: profile.name,
      configFingerprint: fingerprint(profile),
      ...(callerModelId !== undefined ? { callerModelId } : {}),
    });
    await this.deps.registry.put(created.record);
    this.liveSessions.set(sessionKey, created);
    return created;
  }

  private async runDelegatedTurn(
    session: ManagedSession,
    record: CallRecord,
  ): Promise<void> {
    await this.deps.calls.update(record.callId, { status: "running" });
    // "auto" model (explicit or unset): mirror the caller's model on every
    // delegated turn, including sessions that were already live.
    const profile = await this.deps.profiles.get(record.targetAgent);
    if (profile && autoModel(profile) && record.callerModelId) {
      await this.deps.host
        .applyModelId(session, record.callerModelId)
        .catch(() => undefined); // best effort: keep the current model on failure
    }
    let result: TurnResult;
    try {
      result = await this.deps.host.runTurn(session, record);
    } catch (err) {
      result = {
        callId: record.callId,
        sourceSessionKey: record.targetSessionKey,
        outcome: "failed",
        content: "",
        error: (err as Error).message,
      };
    }
    const settled = await this.deps.calls.settle(record.callId, {
      status: result.outcome === "completed" ? "settled" : result.outcome,
      summary: result.outcome === "needs_input" ? (result.question ?? result.content) : result.content,
    });
    if (settled.status === "settled" || settled.status === "needs_input") {
      // Await delivery inside the mailbox task so retries are ordered and
      // observable; on failure the record stays settled/needs_input for
      // flushOutbox().
      await this.tryDeliver(settled, result);
    } else if (settled.status === "failed" || settled.status === "cancelled") {
      await this.tryDeliver(settled, result);
    }
  }

  /** Attempt one callback delivery; marks the call delivered on success. */
  private async tryDeliver(call: CallRecord, result?: TurnResult): Promise<boolean> {
    try {
      const ok = await this.deps.deliverer.deliver(
        call.caller,
        renderCallback(call, result),
        call.callId,
      );
      if (ok) await this.deps.calls.markDelivered(call.callId);
      return ok;
    } catch {
      return false;
    }
  }

  private async runLocalFollowUp(
    session: ManagedSession,
    record: CallRecord,
  ): Promise<void> {
    await this.deps.calls.update(record.callId, { status: "running" });
    try {
      await this.deps.host.enqueueFollowUp(session, record);
      await this.deps.calls.settle(record.callId, {
        status: "settled",
        summary: "processed as a local follow-up",
      });
      // No callback: the caller IS this session (architecture.md §9).
    } catch (err) {
      await this.deps.calls.settle(record.callId, {
        status: "failed",
        summary: `local follow-up failed: ${(err as Error).message}`,
      });
    }
  }

}

export class UnknownAgentError extends Error {
  constructor(agent: string, known: AgentProfile[]) {
    const names = known.map((p) => p.name).join(", ") || "(none defined yet)";
    super(`Unknown agent "${agent}". Defined profiles: ${names}.`);
  }
}

export class DepthLimitError extends Error {
  constructor(max: number) {
    super(`Delegation depth limit (${max}) exceeded.`);
  }
}

/** True when the profile mirrors the caller's model ("auto" or unset). */
export function autoModel(profile: AgentProfile): boolean {
  return profile.model === undefined || profile.model === "auto";
}

export function fingerprint(profile: AgentProfile): string {
  const material = [
    profile.name,
    profile.instructions,
    autoModel(profile) ? "" : profile.model!,
    [...profile.tools].sort().join(","),
  ].join("\u0000");
  // Cheap non-crypto fingerprint is enough for drift detection.
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fp_${(h >>> 0).toString(16)}`;
}

export function renderCallback(call: CallRecord, result?: TurnResult): string {
  if (call.status === "needs_input") {
    const question = result?.question ?? call.summary ?? "(no question text)";
    return (
      `<delegation_question callId="${call.callId}" agent="${call.targetAgent}">\n` +
      `The agent "${call.targetAgent}" needs information before it can finish.\n\n` +
      `Question: ${question}\n\n` +
      `Answer it yourself if you can, otherwise ask the user. Then send the answer ` +
      `with delegate(agent="${call.targetAgent}", prompt=<answer, plus the original task if ` +
      `needed for context>) — the agent continues in the same session and will reply ` +
      `with a delegation_result.` +
      `</delegation_question>`
    );
  }
  const body = result?.content ?? call.summary ?? "(no content)";
  const warning = result?.protocolWarning
    ? "\n\nNote: the agent did not call yield_to_caller; this is its final assistant text."
    : "";
  const statusLine =
    call.status === "cycle_rejected"
      ? `DELEGATION CYCLE REJECTED for "${call.targetAgent}"`
      : call.status === "failed"
        ? `Delegation to "${call.targetAgent}" FAILED`
        : `Delegation result from "${call.targetAgent}"`;
  return (
    `<delegation_result callId="${call.callId}" agent="${call.targetAgent}" status="${call.status}">\n` +
    `${statusLine}\n\n${body}${warning}\n` +
    `</delegation_result>`
  );
}

/** Utility: is this session key part of this project? */
export function keyBelongsToProject(key: string, projectId: string): boolean {
  const parsed = parseSessionKey(key);
  return parsed?.projectId === projectId;
}
