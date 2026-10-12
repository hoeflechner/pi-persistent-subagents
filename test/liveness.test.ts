import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Liveness, STALE_AFTER_MS } from "../src/core/liveness.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-subagents-live-"));
}

describe("liveness markers", () => {
  it("reads a stamping instance as live and an unstamped one as dead", async () => {
    const dir = await tmpDir();
    new Liveness(dir, "proc-a").start();
    expect(new Liveness(dir, "proc-b").liveInstances()).toEqual(new Set(["proc-a"]));
  });

  it("reads a marker older than STALE_AFTER_MS as dead (crashed process)", async () => {
    const dir = await tmpDir();
    new Liveness(dir, "proc-a").start();
    const stale = (Date.now() - STALE_AFTER_MS - 1000) / 1000;
    await fs.utimes(path.join(dir, "live", "proc-a"), stale, stale);
    expect(new Liveness(dir, "proc-b").liveInstances()).toEqual(new Set());
  });

  it("treats a missing marker dir as nobody-live (recovery stays correct)", async () => {
    const dir = await tmpDir();
    expect(new Liveness(dir, "proc-x").liveInstances()).toEqual(new Set());
  });
});
