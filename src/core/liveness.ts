import fs from "node:fs";
import path from "node:path";

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
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** A marker older than this belongs to a dead instance (≈4 missed beats). */
export const STALE_AFTER_MS = 90_000;

/** Drop a dead instance's marker entirely after this long (bookkeeping). */
const MARKER_TTL_MS = 24 * 60 * 60_000;

export class Liveness {
  private readonly dir: string;
  private timer?: NodeJS.Timeout;

  constructor(
    stateDir: string,
    // randomUUID() from the extension layer: safe as a filename, and it never
    // collides with another process's marker.
    private readonly instanceId: string,
  ) {
    this.dir = path.join(stateDir, "live");
  }

  /** Stamp this instance live and keep it stamped for this process's lifetime.
   * Stamping does NOT stop when the last session closes: a host process that is
   * still running a delegated turn must keep owning it, or another instance's
   * recovery would reap work that is about to settle. Garbage markers from dead
   * processes are pruned by TTL in liveInstances(). */
  start(): void {
    this.stamp();
    if (this.timer) return;
    this.timer = setInterval(() => this.stamp(), HEARTBEAT_INTERVAL_MS);
    this.timer.unref?.(); // bookkeeping must not keep a host process alive
  }

  /** Instance ids whose marker is fresh — i.e. still able to run their calls. */
  liveInstances(): Set<string> {
    const live = new Set<string>();
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return live; // no markers yet: nobody else is live
    }
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const name of names) {
      try {
        const { mtimeMs } = fs.statSync(path.join(this.dir, name));
        if (mtimeMs >= cutoff) {
          live.add(name);
        } else if (Date.now() - mtimeMs > MARKER_TTL_MS) {
          // Long-dead instance: forget it, so the dir does not grow per session.
          fs.rmSync(path.join(this.dir, name), { force: true });
        }
      } catch {
        // marker vanished underneath us: treat the instance as dead
      }
    }
    return live;
  }

  private stamp(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, this.instanceId), `${process.pid}\n`, "utf8");
    } catch {
      // Unwritable markers degrade to the old behaviour (orphaned calls get
      // reaped at the next start); never fail a session over bookkeeping.
    }
  }
}
