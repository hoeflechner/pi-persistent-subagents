/**
 * Cross-process liveness markers (architecture.md §10).
 *
 * calls.json is ONE global store shared by every pi process, and a call record
 * alone cannot say whether the runtime that owns it is still alive: the
 * mailbox and the managed sessions that run a call live *in that process*.
 * Reaping `running`/`queued` calls at startup without asking therefore made
 * every session start interrupt every other session's delegations (observed
 * 2026-10-12: 4/4 delegations lost with nothing but ordinary session activity).
 *
 * Each extension instance owns a marker named by its instance id, stamped on
 * start and refreshed by a heartbeat; `delegate()` records that id on the call
 * it creates. Startup recovery reaps a call only when the instance that
 * created it has no fresh marker — which also catches a caller that resumed
 * under a new instance id after a crash, something keying on the session id
 * could not tell apart. A dead process stops stamping, so its orphaned calls
 * are reaped once the marker goes stale.
 */
/** Refresh interval for this instance's marker. */
export declare const HEARTBEAT_INTERVAL_MS = 20000;
/** A marker older than this belongs to a dead instance (≈4 missed beats). */
export declare const STALE_AFTER_MS = 90000;
export declare class Liveness {
    private readonly instanceId;
    private readonly dir;
    private timer?;
    constructor(stateDir: string, instanceId: string);
    /** Stamp this instance live and keep it stamped for this process's lifetime.
     * Stamping does NOT stop when the last session closes: a host process that is
     * still running a delegated turn must keep owning it, or another instance's
     * recovery would reap work that is about to settle. Garbage markers from dead
     * processes are pruned by TTL in liveInstances(). */
    start(): void;
    /** Instance ids whose marker is fresh — i.e. still able to run their calls. */
    liveInstances(): Set<string>;
    private stamp;
}
