import type { CallRecord } from "./types.js";
export declare class CallStore {
    private readonly instanceId?;
    private readonly store;
    /** `instanceId` identifies this extension instance (process); calls created
     * here are owned by it and survive another instance's startup recovery. */
    constructor(stateDir: string, instanceId?: string | undefined);
    create(record: CallRecord): Promise<void>;
    get(callId: string): Promise<CallRecord | undefined>;
    update(callId: string, patch: Partial<CallRecord>): Promise<CallRecord>;
    /**
     * Atomically settle a call and enqueue its callback. Returns the settled
     * record. Settling an already-settled call is a no-op returning the record
     * (idempotent for crash-recovery paths).
     */
    settle(callId: string, patch: Partial<CallRecord>): Promise<CallRecord>;
    /** Mark a callback delivered after successful injection. Idempotent. */
    markDelivered(callId: string): Promise<void>;
    /** Calls with a pending callback: settled/failed/cancelled/cycle-rejected
     * but not yet delivered. Local follow-ups never call back. */
    pendingCallbacks(): Promise<CallRecord[]>;
    /**
     * On startup, a call still `running` or `queued` is interrupted ONLY if the
     * instance that owns it is gone: this store is global, so another live
     * process may be driving that call right now. `liveInstances` comes from the
     * liveness markers (core/liveness.ts); pass an empty set for a deliberate
     * full sweep. Never assume the external effect happened.
     */
    recoverInterrupted(liveInstances: Set<string>): Promise<CallRecord[]>;
    list(): Promise<CallRecord[]>;
}
