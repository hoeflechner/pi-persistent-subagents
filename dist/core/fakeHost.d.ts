import type { CallRecord, SessionRecord, TurnResult } from "./types.js";
import type { ManagedSession, NewSessionSpec, SessionHost } from "./sessionHost.js";
/**
 * In-memory fake host for routing tests.
 *
 * Records every prompt/follow-up, enforces the one-active-turn rule, and
 * lets tests control turn completion manually.
 */
export declare class FakeSessionHost implements SessionHost {
    readonly opened: string[];
    readonly created: NewSessionSpec[];
    readonly prompts: CallRecord[];
    readonly followUps: CallRecord[];
    readonly aborted: string[];
    readonly closed: string[];
    /** Keys that currently have an active turn. */
    readonly busy: Set<string>;
    /** Test hook: how runTurn resolves. */
    turnResolver: (call: CallRecord) => TurnResult;
    /** Test hook: block runTurn until releaseTurn() is called. A release that
     * arrives before a gated turn registers its resolver is LATCHED and consumed
     * by the next gated turn — never dropped. */
    gateTurns: boolean;
    private releaseFns;
    private pendingRelease;
    open(record: SessionRecord): Promise<ManagedSession>;
    readonly modelIds: Map<string, string>;
    applyModelId(session: ManagedSession, modelId: string): Promise<void>;
    create(spec: NewSessionSpec): Promise<ManagedSession>;
    runTurn(session: ManagedSession, call: CallRecord): Promise<TurnResult>;
    enqueueFollowUp(session: ManagedSession, call: CallRecord): Promise<void>;
    abort(_session: ManagedSession, callId: string): Promise<void>;
    close(session: ManagedSession): Promise<void>;
    releaseTurn(): void;
}
