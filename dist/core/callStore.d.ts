import type { CallRecord } from "./types.js";
export declare class CallStore {
    private readonly store;
    constructor(stateDir: string);
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
     * On startup, any call still `running` was interrupted by process loss.
     * Recover as failed-interrupted; never assume the external effect happened.
     */
    recoverInterrupted(): Promise<CallRecord[]>;
    list(): Promise<CallRecord[]>;
}
