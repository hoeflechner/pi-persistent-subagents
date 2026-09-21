import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CallStore } from "../src/core/callStore.js";
import { FakeSessionHost } from "../src/core/fakeHost.js";
import { MailboxRegistry } from "../src/core/mailbox.js";
import { ProfileStore } from "../src/core/profileStore.js";
import { DelegationRouter, type CallbackDeliverer } from "../src/core/router.js";
import { SessionRegistry } from "../src/core/registry.js";
import { buildSessionKey, canonicalProjectId } from "../src/core/keys.js";
import type { CallerAddress } from "../src/core/types.js";

const PROJECT = canonicalProjectId("/repo/demo");

interface Harness {
  router: DelegationRouter;
  profiles: ProfileStore;
  registry: SessionRegistry;
  calls: CallStore;
  mailboxes: MailboxRegistry;
  host: FakeSessionHost;
  deliverer: FakeDeliverer;
}

class FakeDeliverer implements CallbackDeliverer {
  readonly delivered: Array<{ caller: CallerAddress; message: string; callId: string }> = [];
  reachable = true;
  async deliver(caller: CallerAddress, message: string, callId: string): Promise<boolean> {
    if (!this.reachable) return false;
    this.delivered.push({ caller, message, callId });
    return true;
  }
}

async function makeHarness(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagents-test-"));
  const profiles = new ProfileStore({ userProfilesFile: path.join(dir, "profiles.yaml") });
  await profiles.set({ name: "research", description: "", bootstrap: "You are a research agent.", tools: ["read"]});
  await profiles.set({ name: "planner", description: "", bootstrap: "You are a planner.", tools: ["read"]});
  const registry = new SessionRegistry(dir);
  const calls = new CallStore(dir);
  const mailboxes = new MailboxRegistry();
  const host = new FakeSessionHost();
  const deliverer = new FakeDeliverer();
  const router = new DelegationRouter({
    projectId: PROJECT,
    profiles,
    registry,
    calls,
    mailboxes,
    host,
    deliverer,
  });
  return { router, profiles, registry, calls, mailboxes, host, deliverer };
}

const rootCaller = (): { address: CallerAddress; ancestry: string[]; depth: number } => ({
  address: { kind: "root", sessionId: "root-session", label: "main" },
  ancestry: [],
  depth: 0,
});

function managedCaller(agent: string, ancestry: string[], depth: number) {
  const key = buildSessionKey(PROJECT, agent);
  return {
    address: { kind: "managed" as const, sessionId: `session-${agent}`, sessionKey: key, label: agent },
    sessionKey: key,
    ancestry,
    depth,
  };
}

describe("delegate router", () => {
  it("returns a receipt immediately without waiting for the turn", async () => {
    const h = await makeHarness();
    h.host.gateTurns = true;
    const receipt = await h.router.delegate({ agent: "research", prompt: "dig in" }, rootCaller());
    expect(receipt.kind).toBe("delegation_receipt");
    expect(receipt.status).toBe("queued");
    expect(receipt.callId).toBeTruthy();
    // The turn has not completed (it may already be running).
    const record = await h.calls.get(receipt.callId);
    expect(["queued", "running"]).toContain(record?.status);
    h.host.releaseTurn();
    await h.mailboxes.allIdle();
    const settled = await h.calls.get(receipt.callId);
    expect(settled?.status).toBe("settled");
    expect(settled?.callbackDeliveredAt).toBeTruthy();
  });

  it("ask_caller settles as needs_input and delivers a delegation_question callback", async () => {
    const h = await makeHarness();
    h.host.turnResolver = (call) => ({
      callId: call.callId,
      sourceSessionKey: call.targetSessionKey,
      outcome: "needs_input",
      content: "Which sensor variant is meant: BME280 or BMP280?",
      question: "Which sensor variant is meant: BME280 or BMP280?",
    });
    const receipt = await h.router.delegate(
      { agent: "research", prompt: "compare the sensors" },
      rootCaller(),
    );
    await h.mailboxes.allIdle();
    const record = await h.calls.get(receipt.callId);
    expect(record?.status).toBe("needs_input");
    expect(record?.callbackDeliveredAt).toBeTruthy();
    expect(h.deliverer.delivered).toHaveLength(1);
    const msg = h.deliverer.delivered[0]?.message;
    expect(msg).toContain("<delegation_question");
    expect(msg).toContain("Which sensor variant is meant: BME280 or BMP280?");
    expect(msg).toContain('delegate(agent="research"');
    // The answer arrives as a NEW delegate call reusing the same session.
    h.host.turnResolver = (call) => ({
      callId: call.callId,
      sourceSessionKey: call.targetSessionKey,
      outcome: "completed",
      content: "BMP280 compared, findings written.",
    });
    const answer = await h.router.delegate(
      { agent: "research", prompt: "Answer: BMP280. Continue." },
      rootCaller(),
    );
    await h.mailboxes.allIdle();
    expect(h.host.created).toHaveLength(1); // same session reused
    const settled = await h.calls.get(answer.callId);
    expect(settled?.status).toBe("settled");
    expect(h.deliverer.delivered).toHaveLength(2);
    expect(h.deliverer.delivered[1]?.message).toContain("<delegation_result");
  });

  it("creates the target session exactly once and reuses it", async () => {
    const h = await makeHarness();
    await h.router.delegate({ agent: "research", prompt: "a" }, rootCaller());
    await h.mailboxes.allIdle();
    await h.router.delegate({ agent: "research", prompt: "b" }, rootCaller());
    await h.mailboxes.allIdle();
    expect(h.host.created).toHaveLength(1);
    expect(h.host.prompts).toHaveLength(2);
    const key = buildSessionKey(PROJECT, "research");
    const record = await h.registry.get(key);
    expect(record?.agentName).toBe("research");
  });

  it("same-agent call from a managed session becomes a local follow-up", async () => {
    const h = await makeHarness();
    const key = buildSessionKey(PROJECT, "research");
    // The caller's own session is live in the host.
    h.router.registerLiveSession({
      record: {
        schemaVersion: 1,
        sessionKey: key,
        projectId: PROJECT,
        agentName: "research",
        sessionId: "session-research",
        sessionPath: "/fake/sessions/research.jsonl",
        displayName: "research",
        configFingerprint: "fp_test",
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      },
    });
    const receipt = await h.router.delegate(
      { agent: "research", prompt: "more please" },
      managedCaller("research", [], 1),
    );
    expect(receipt.kind).toBe("local_follow_up");
    await h.mailboxes.allIdle();
    // No new session, no callback into self.
    expect(h.host.created).toHaveLength(0);
    expect(h.host.followUps).toHaveLength(1);
    expect(h.deliverer.delivered).toHaveLength(0);
    const record = await h.calls.get(receipt.callId);
    expect(record?.status).toBe("settled");
    expect(record?.localFollowUp).toBe(true);
    expect(key).toBeTruthy();
  });

  it("rejects cross-agent cycles and reports the path", async () => {
    const h = await makeHarness();
    const researchKey = buildSessionKey(PROJECT, "research");
    const plannerKey = buildSessionKey(PROJECT, "planner");
    // planner was reached from research; delegating back to research is a cycle.
    const receipt = await h.router.delegate(
      { agent: "research", prompt: "loop?" },
      managedCaller("planner", ["root", researchKey, plannerKey], 2),
    );
    expect(receipt.status).toBe("cycle_rejected");
    await h.mailboxes.allIdle();
    expect(h.host.prompts).toHaveLength(0); // never executed
    expect(h.deliverer.delivered).toHaveLength(1);
    expect(h.deliverer.delivered[0]?.message).toContain(researchKey);
    const record = await h.calls.get(receipt.callId);
    expect(record?.status).toBe("cycle_rejected");
  });

  it("enforces FIFO order with one active turn per key", async () => {
    const h = await makeHarness();
    h.host.gateTurns = true;
    const r1 = await h.router.delegate({ agent: "research", prompt: "first" }, rootCaller());
    const r2 = await h.router.delegate({ agent: "research", prompt: "second" }, rootCaller());
    // Only one prompt may be active at a time (fake host throws otherwise).
    expect(h.host.prompts).toHaveLength(1);
    expect(h.host.prompts[0]?.prompt).toBe("first");
    h.host.releaseTurn();
    await waitFor(() => h.host.prompts.length === 2);
    expect(h.host.prompts[1]?.prompt).toBe("second");
    h.host.releaseTurn();
    await h.mailboxes.allIdle();
    expect((await h.calls.get(r1.callId))?.callbackDeliveredAt).toBeTruthy();
    expect((await h.calls.get(r2.callId))?.callbackDeliveredAt).toBeTruthy();
  });

  it("delivers callbacks to the immediate caller, not the root", async () => {
    const h = await makeHarness();
    const researchKey = buildSessionKey(PROJECT, "research");
    const receipt = await h.router.delegate(
      { agent: "planner", prompt: "plan it" },
      managedCaller("research", ["root", researchKey], 1),
    );
    await h.mailboxes.allIdle();
    expect(h.deliverer.delivered).toHaveLength(1);
    expect(h.deliverer.delivered[0]?.caller.kind).toBe("managed");
    expect(h.deliverer.delivered[0]?.caller.sessionId).toBe("session-research");
    expect(h.deliverer.delivered[0]?.message).toContain(receipt.callId);
  });

  it("keeps callbacks pending when the caller is unreachable, then flushes", async () => {
    const h = await makeHarness();
    h.deliverer.reachable = false;
    const receipt = await h.router.delegate({ agent: "research", prompt: "x" }, rootCaller());
    await h.mailboxes.allIdle();
    const record = await h.calls.get(receipt.callId);
    expect(record?.status).toBe("settled"); // settled but not delivered
    expect(record?.callbackDeliveredAt).toBeUndefined();
    h.deliverer.reachable = true;
    const n = await h.router.flushOutbox();
    expect(n).toBe(1);
    expect((await h.calls.get(receipt.callId))?.callbackDeliveredAt).toBeTruthy();
    // Second flush must not re-deliver (dedup via status).
    expect(await h.router.flushOutbox()).toBe(0);
    expect(h.deliverer.delivered).toHaveLength(1);
  });

  it("recovers interrupted running calls on reconcile", async () => {
    const h = await makeHarness();
    h.deliverer.reachable = false;
    const receipt = await h.router.delegate({ agent: "research", prompt: "x" }, rootCaller());
    await h.mailboxes.allIdle();
    await h.calls.update(receipt.callId, { status: "running" });
    // Simulate restart: fresh stores over the same directory would reload;
    // here we call reconcile directly on the same store.
    h.deliverer.reachable = true;
    const { recovered, delivered } = await h.router.reconcile();
    expect(recovered).toBe(1);
    expect(delivered).toBe(1);
    const record = await h.calls.get(receipt.callId);
    expect(record?.status).toBe("failed");
    expect(record?.callbackDeliveredAt).toBeTruthy();
    expect(record?.error).toBe("interrupted-by-restart");
  });

  it("rejects unknown agents with the list of known profiles", async () => {
    const h = await makeHarness();
    await expect(
      h.router.delegate({ agent: "nope", prompt: "x" }, rootCaller()),
    ).rejects.toThrow(/planner, research|research, planner/);
  });

  it("enforces the depth limit", async () => {
    const h = await makeHarness();
    const ancestry = Array.from({ length: 8 }, (_, i) => `v1:${PROJECT}:agent${i}`);
    await expect(
      h.router.delegate({ agent: "planner", prompt: "x" }, managedCaller("research", ancestry, 8)),
    ).rejects.toThrow(/depth/i);
  });

  it("persists state atomically across stores", async () => {
    const h = await makeHarness();
    const receipt = await h.router.delegate({ agent: "research", prompt: "x" }, rootCaller());
    await h.mailboxes.allIdle();
    // Re-open stores over the same dirs to prove durability.
    const dir = h.registry.dir();
    const calls2 = new CallStore(dir);
    const record = await calls2.get(receipt.callId);
    expect(record?.callbackDeliveredAt).toBeTruthy();
  });

  it('model "auto" (unset) mirrors the caller model on each delegated turn', async () => {
    const h = await makeHarness();
    const caller = { ...rootCaller(), callerModelId: "gpt-5.5" };
    const receipt = await h.router.delegate({ agent: "research", prompt: "x" }, caller);
    await h.mailboxes.allIdle();
    const key = buildSessionKey(PROJECT, "research");
    expect(h.host.modelIds.get(key)).toBe("gpt-5.5");
    const record = await h.calls.get(receipt.callId);
    expect(record?.callerModelId).toBe("gpt-5.5");
  });

  it("an explicit profile model is not overridden by the caller model", async () => {
    const h = await makeHarness();
    await h.profiles.set({
      name: "planner",
      description: "",
      bootstrap: "You are a planner.",
      model: "claude",
      tools: ["read"],

    });
    const caller = { ...rootCaller(), callerModelId: "gpt-5.5" };
    await h.router.delegate({ agent: "planner", prompt: "x" }, caller);
    await h.mailboxes.allIdle();
    expect(h.host.modelIds.get(buildSessionKey(PROJECT, "planner"))).toBeUndefined();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
