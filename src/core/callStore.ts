import path from "node:path";
import { createJsonStore, type JsonStore } from "./jsonStore.js";
import type { CallRecord } from "./types.js";

/**
 * Durable call receipts + callback outbox (architecture.md §6).
 *
 * Settlement and outbox creation happen in one update() call, giving the
 * broker's "atomic from the broker's perspective" guarantee. Delivery is
 * at-least-once; consumers deduplicate on callId.
 */

interface CallsFile {
  schemaVersion: 1;
  calls: Record<string, CallRecord>;
}

export class CallStore {
  private readonly store: JsonStore<CallsFile>;

  /** `instanceId` identifies this extension instance (process); calls created
   * here are owned by it and survive another instance's startup recovery. */
  constructor(
    stateDir: string,
    private readonly instanceId?: string,
  ) {
    this.store = createJsonStore<CallsFile>(path.join(stateDir, "calls.json"), () => ({
      schemaVersion: 1,
      calls: {},
    }));
  }

  async create(record: CallRecord): Promise<void> {
    await this.store.update((state) => {
      if (state.calls[record.callId]) {
        throw new Error(`duplicate callId ${record.callId}`);
      }
      state.calls[record.callId] = this.instanceId
        ? { ...record, ownerInstanceId: this.instanceId }
        : record;
    });
  }

  async get(callId: string): Promise<CallRecord | undefined> {
    const state = await this.store.read();
    return state.calls[callId];
  }

  async update(callId: string, patch: Partial<CallRecord>): Promise<CallRecord> {
    let updated: CallRecord | undefined;
    await this.store.update((state) => {
      const existing = state.calls[callId];
      if (!existing) throw new Error(`unknown callId ${callId}`);
      updated = { ...existing, ...patch, callId: existing.callId };
      state.calls[callId] = updated;
    });
    return updated as CallRecord;
  }

  /**
   * Atomically settle a call and enqueue its callback. Returns the settled
   * record. Settling an already-settled call is a no-op returning the record
   * (idempotent for crash-recovery paths).
   */
  async settle(
    callId: string,
    patch: Partial<CallRecord>,
  ): Promise<CallRecord> {
    let result: CallRecord | undefined;
    await this.store.update((state) => {
      const existing = state.calls[callId];
      if (!existing) throw new Error(`unknown callId ${callId}`);
      if (isTerminal(existing.status)) {
        result = existing;
        return;
      }
      result = { ...existing, ...patch, settledAt: new Date().toISOString() };
      state.calls[callId] = result;
    });
    return result as CallRecord;
  }

  /** Mark a callback delivered after successful injection. Idempotent. */
  async markDelivered(callId: string): Promise<void> {
    await this.store.update((state) => {
      const existing = state.calls[callId];
      if (existing && DELIVERABLE.has(existing.status) && !existing.callbackDeliveredAt) {
        existing.callbackDeliveredAt = new Date().toISOString();
      }
    });
  }

  /** Calls with a pending callback: settled/failed/cancelled/cycle-rejected
   * but not yet delivered. Local follow-ups never call back. */
  async pendingCallbacks(): Promise<CallRecord[]> {
    const state = await this.store.read();
    return Object.values(state.calls)
      .filter((c) => DELIVERABLE.has(c.status) && !c.callbackDeliveredAt && !c.localFollowUp)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * On startup, a call still `running` or `queued` is interrupted ONLY if the
   * instance that owns it is gone: this store is global, so another live
   * process may be driving that call right now. `liveInstances` comes from the
   * liveness markers (core/liveness.ts); pass an empty set for a deliberate
   * full sweep. Never assume the external effect happened.
   */
  async recoverInterrupted(liveInstances: Set<string>): Promise<CallRecord[]> {
    const recovered: CallRecord[] = [];
    await this.store.update((state) => {
      for (const call of Object.values(state.calls)) {
        if (call.status !== "running" && call.status !== "queued") continue;
        if (call.ownerInstanceId && liveInstances.has(call.ownerInstanceId)) continue;
        call.status = "failed";
        call.summary =
          "Interrupted: the extension restarted while this call was active. The delegated turn may or may not have completed; do not assume its effects happened.";
        call.error = "interrupted-by-restart";
        call.settledAt = new Date().toISOString();
        recovered.push(call);
      }
    });
    return recovered;
  }

  async list(): Promise<CallRecord[]> {
    const state = await this.store.read();
    return Object.values(state.calls).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }
}

/** Statuses that have a callback owed to the caller until delivered.
 * "needs_input" is terminal for this call: the question callback is owed,
 * and the caller's answer arrives as a NEW delegate call on the same session. */
const DELIVERABLE = new Set([
  "settled",
  "needs_input",
  "failed",
  "cancelled",
  "cycle_rejected",
]);

function isTerminal(status: string): boolean {
  return DELIVERABLE.has(status);
}
