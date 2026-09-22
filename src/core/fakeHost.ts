import { randomUUID } from "node:crypto";
import type { CallRecord, SessionRecord, TurnResult } from "./types.js";
import type { ManagedSession, NewSessionSpec, SessionHost } from "./sessionHost.js";

/**
 * In-memory fake host for routing tests.
 *
 * Records every prompt/follow-up, enforces the one-active-turn rule, and
 * lets tests control turn completion manually.
 */
export class FakeSessionHost implements SessionHost {
  readonly opened: string[] = [];
  readonly created: NewSessionSpec[] = [];
  readonly prompts: CallRecord[] = [];
  readonly followUps: CallRecord[] = [];
  readonly aborted: string[] = [];
  readonly closed: string[] = [];

  /** Keys that currently have an active turn. */
  readonly busy = new Set<string>();

  /** Test hook: how runTurn resolves. */
  turnResolver: (call: CallRecord) => TurnResult = (call) => ({
    callId: call.callId,
    sourceSessionKey: call.targetSessionKey,
    outcome: "completed",
    content: `result for ${call.targetAgent}: ${call.prompt.slice(0, 40)}`,
  });

  /** Test hook: block runTurn until releaseTurn() is called. A release that
   * arrives before a gated turn registers its resolver is LATCHED and consumed
   * by the next gated turn — never dropped. */
  gateTurns = false;
  private releaseFns: Array<() => void> = [];
  private pendingRelease = false;

  async open(record: SessionRecord): Promise<ManagedSession> {
    this.opened.push(record.sessionKey);
    return { record };
  }

  readonly modelIds = new Map<string, string>();

  async applyModelId(session: ManagedSession, modelId: string): Promise<void> {
    this.modelIds.set(session.record.sessionKey, modelId);
  }

  async create(spec: NewSessionSpec): Promise<ManagedSession> {
    this.created.push(spec);
    const record: SessionRecord = {
      schemaVersion: 1,
      sessionKey: spec.sessionKey,
      projectId: spec.projectId,
      agentName: spec.profile.name,
      sessionId: randomUUID(),
      sessionPath: `/fake/sessions/${spec.profile.name}.jsonl`,
      displayName: spec.displayName,
      configFingerprint: spec.configFingerprint,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    return { record };
  }

  async runTurn(session: ManagedSession, call: CallRecord): Promise<TurnResult> {
    if (this.busy.has(session.record.sessionKey)) {
      throw new Error(
        `Agent is already processing: ${session.record.sessionKey} (router violated one-active-turn)`,
      );
    }
    this.busy.add(session.record.sessionKey);
    this.prompts.push(call);
    try {
      if (this.gateTurns) {
        if (this.pendingRelease) this.pendingRelease = false;
        else await new Promise<void>((resolve) => this.releaseFns.push(resolve));
      }
      return this.turnResolver(call);
    } finally {
      this.busy.delete(session.record.sessionKey);
    }
  }

  async enqueueFollowUp(session: ManagedSession, call: CallRecord): Promise<void> {
    this.followUps.push(call);
  }

  async abort(_session: ManagedSession, callId: string): Promise<void> {
    this.aborted.push(callId);
  }

  async close(session: ManagedSession): Promise<void> {
    this.closed.push(session.record.sessionKey);
  }

  releaseTurn(): void {
    const fn = this.releaseFns.shift();
    if (fn) fn();
    else this.pendingRelease = true; // latch: no gated turn registered yet
  }
}
