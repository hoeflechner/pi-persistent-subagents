/**
 * Core data types for persistent subagent delegation.
 *
 * These mirror doc/architecture.md §6–§9. They are intentionally free of any
 * Pi SDK imports so the routing core can be tested with a fake session host.
 */
export type AgentName = string;
/** Durable mapping from a stable session key to an exact Pi session. */
export interface SessionRecord {
    schemaVersion: 1;
    sessionKey: string;
    projectId: string;
    agentName: AgentName;
    /** Pi session UUID. */
    sessionId: string;
    /** Absolute path of the Pi JSONL session file. */
    sessionPath: string;
    displayName: string;
    /** Fingerprint of profile prompt/model/tool policy at creation time. */
    configFingerprint: string;
    createdAt: string;
    lastUsedAt: string;
}
/** Where a delegation callback must be delivered. */
export interface CallerAddress {
    kind: "root" | "managed";
    /** Exact Pi session id of the caller. */
    sessionId: string;
    /** Present for managed callers. */
    sessionKey?: string;
    /** Human-facing label used in callback rendering. */
    label: string;
}
export type CallStatus = "queued" | "running" | "settled" | "needs_input" | "failed" | "cancelled" | "cycle_rejected";
/** Durable receipt record; survives extension restart. */
export interface CallRecord {
    callId: string;
    rootCallId: string;
    status: CallStatus;
    targetSessionKey: string;
    targetAgent: AgentName;
    caller: CallerAddress;
    prompt: string;
    ancestry: string[];
    depth: number;
    createdAt: string;
    /** Model the caller was running when it delegated (for profile model="auto"). */
    callerModelId?: string;
    settledAt?: string;
    /** Path to a stored full-result artifact when output was truncated. */
    resultArtifact?: string;
    /** Short model-visible summary of the settled result. */
    summary?: string;
    /** Machine-readable failure reason, e.g. "interrupted-by-restart". */
    error?: string;
    /** Set once the callback has been injected into the caller. */
    callbackDeliveredAt?: string;
    /** True when the call was routed as a same-session follow-up. */
    localFollowUp?: boolean;
}
export type TurnOutcome = "completed" | "needs_input" | "failed" | "cancelled" | "cycle_rejected";
export interface TurnResult {
    callId: string;
    sourceSessionKey: string;
    outcome: TurnOutcome;
    content: string;
    /** True when the model omitted yield_to_caller and final text was used. */
    protocolWarning?: boolean;
    /** Set when outcome is "needs_input": the agent's question for the caller. */
    question?: string;
    error?: string;
}
/** What the delegate tool returns immediately (fire-and-forget). */
export interface DelegationReceipt {
    kind: "delegation_receipt" | "local_follow_up";
    callId: string;
    targetAgent: AgentName;
    status: "queued" | "cycle_rejected";
    message: string;
}
/** A user-defined agent profile. Names are dynamic data, not a union. */
export interface AgentProfile {
    name: AgentName;
    description: string;
    instructions: string;
    /**
     * Model selector: a pattern like "anthropic/claude-...", or "auto" (and
     * undefined) to mirror the calling agent's model on every delegate call.
     */
    model?: string;
    /**
     * Tool allowlist. Must not include yield_to_caller or ask_caller; both are
     * always granted.
     */
    tools: string[];
    /** Origin of the definition, for trust decisions. */
    source: "user" | "project" | "default";
}
/** Input to the delegate tool. */
export interface DelegateRequest {
    agent: AgentName;
    prompt: string;
}
/** Identity of whoever invokes the delegate tool. */
export interface CallerIdentity {
    address: CallerAddress;
    /** Session key when the caller is itself a managed session. */
    sessionKey?: string;
    /** Causal ancestry of session keys, oldest first. Empty for root callers. */
    ancestry: string[];
    depth: number;
}
