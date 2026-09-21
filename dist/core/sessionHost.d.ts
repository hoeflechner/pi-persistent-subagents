import type { AgentProfile, CallRecord, SessionRecord, TurnResult } from "./types.js";
/**
 * Session host boundary (architecture.md §6).
 *
 * MVP implementation will wrap Pi SDK AgentSession objects; an RPC adapter
 * can implement the same interface later without touching the router.
 */
export interface ManagedSession {
    record: SessionRecord;
}
export interface NewSessionSpec {
    sessionKey: string;
    projectId: string;
    profile: AgentProfile;
    displayName: string;
    configFingerprint: string;
    /** Caller's model id; used when the profile model is "auto"/unset. */
    callerModelId?: string;
}
export interface SessionHost {
    /** Open the exact session file named by the record. The current profile is
     * passed so the host can re-apply its tool policy to the reopened session.
     * callerModelId mirrors the caller's model for profile model="auto". */
    open(record: SessionRecord, profile?: AgentProfile, callerModelId?: string): Promise<ManagedSession>;
    /** Switch a live session's model by pattern/id (used for "auto" re-mirroring
     * on each delegate). Best-effort: hosts may ignore unsupported ids. */
    applyModelId(session: ManagedSession, modelId: string): Promise<void>;
    /** Create a new persistent session (honoring profile model / callerModelId). */
    create(spec: NewSessionSpec): Promise<ManagedSession>;
    /**
     * Run one delegated turn: send the envelope prompt, wait for full
     * settlement (yield_to_caller payload or final assistant text fallback).
     */
    runTurn(session: ManagedSession, call: CallRecord): Promise<TurnResult>;
    /**
     * Queue a follow-up on the live session for a same-agent call. The host
     * must NOT start a second concurrent prompt.
     */
    enqueueFollowUp(session: ManagedSession, call: CallRecord): Promise<void>;
    abort(session: ManagedSession, callId: string): Promise<void>;
    close(session: ManagedSession): Promise<void>;
}
