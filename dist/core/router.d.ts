import type { CallStore } from "./callStore.js";
import type { SessionRegistry } from "./registry.js";
import type { ProfileStore } from "./profileStore.js";
import type { MailboxRegistry } from "./mailbox.js";
import type { ManagedSession, SessionHost } from "./sessionHost.js";
import { type AgentProfile, type CallRecord, type CallerAddress, type DelegateRequest, type DelegationReceipt, type TurnResult } from "./types.js";
/**
 * Delegation router (architecture.md §8-§10).
 *
 * delegate() is fire-and-forget: it persists a call record, enqueues work on
 * the target's FIFO mailbox, and returns a receipt immediately. When the
 * turn settles, a callback is durably queued and delivered to the immediate
 * caller via the CallbackDeliverer.
 */
export declare const MAX_DEPTH = 8;
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
export declare class DelegationRouter {
    private readonly deps;
    private readonly liveSessions;
    private readonly now;
    constructor(deps: RouterDeps);
    /**
     * Register a session that is already live in the host. The extension layer
     * calls this when a managed session starts, so same-key follow-ups reuse it
     * instead of opening a second handle.
     */
    registerLiveSession(session: ManagedSession): void;
    forgetLiveSession(sessionKey: string): void;
    /** Entry point for the delegate tool. Never blocks on the delegated turn. */
    delegate(request: DelegateRequest, caller: {
        address: CallerAddress;
        sessionKey?: string;
        ancestry: string[];
        depth: number;
        rootCallId?: string;
        /** Model id the caller is running; mirrored by "auto" profiles. */
        callerModelId?: string;
    }): Promise<DelegationReceipt>;
    /** Deliver every settled-but-undelivered callback (startup + retries).
     * Confirms previously-queued deliveries first so retries do not duplicate. */
    /** Flush pending callbacks. When opts.rootSessionId is given, callbacks
     * addressed to a ROOT caller are attempted only if the addressee matches
     * that session id exactly — a runtime may never deliver (and self-confirm
     * via confirm()) callbacks addressed to another session. Managed-caller
     * callbacks are always attempted: the deliverer resolves them against its
     * own host live-sessions and declines when the target is absent. */
    flushOutbox(opts?: {
        rootSessionId?: string;
    }): Promise<number>;
    /** Startup: recover interrupted calls, then flush callbacks addressed to
     * the starting session (scoped like flushOutbox). */
    reconcile(opts?: {
        rootSessionId?: string;
    }): Promise<{
        recovered: number;
        delivered: number;
    }>;
    private ensureSession;
    private runDelegatedTurn;
    /** Attempt one callback delivery; marks the call delivered on success. */
    private tryDeliver;
    private runLocalFollowUp;
}
export declare class UnknownAgentError extends Error {
    constructor(agent: string, known: AgentProfile[]);
}
export declare class DepthLimitError extends Error {
    constructor(max: number);
}
/** True when the profile mirrors the caller's model ("auto" or unset). */
export declare function autoModel(profile: AgentProfile): boolean;
export declare function fingerprint(profile: AgentProfile): string;
export declare function renderCallback(call: CallRecord, result?: TurnResult): string;
/** Utility: is this session key part of this project? */
export declare function keyBelongsToProject(key: string, projectId: string): boolean;
