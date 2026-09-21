import { describe, expect, it } from "vitest";
import {
  makeAskTool,
  makeYieldTool,
  renderEnvelope,
  ASK_TOOL_NAME,
  YIELD_TOOL_NAME,
} from "../src/pi/sdkHost.js";
import type { CallRecord } from "../src/core/types.js";

const call: CallRecord = {
  callId: "call-1",
  rootCallId: "call-1",
  status: "queued",
  targetSessionKey: "v1:p_x:research",
  targetAgent: "research",
  caller: { kind: "root", sessionId: "root", label: "main" },
  prompt: "compare A and B",
  ancestry: [],
  depth: 1,
  createdAt: new Date().toISOString(),
};

describe("envelope rendering", () => {
  it("includes call id, caller label, and the yield protocol instruction", () => {
    const text = renderEnvelope(call);
    expect(text).toContain("call-1");
    expect(text).toContain('"main"');
    expect(text).toContain(YIELD_TOOL_NAME);
    expect(text).toContain("compare A and B");
  });

  it("prepends bootstrap exactly once when provided", () => {
    const withBootstrap = renderEnvelope(call, "# You are research");
    expect(withBootstrap.indexOf("# You are research")).toBe(0);
    expect(withBootstrap.indexOf("compare A and B")).toBeGreaterThan(
      withBootstrap.indexOf("delegated call"),
    );
  });
});

describe("yield_to_caller tool", () => {
  it("captures the answer and terminates the run", async () => {
    const holder: { content?: string | undefined } = {};
    const tool = makeYieldTool(holder);
    // The host wires execute() with validated params; call it directly.
    const execute = tool.execute as unknown as (
      id: string,
      params: { answer: string },
    ) => Promise<{ content: Array<{ type: string; text: string }>; terminate?: boolean }>;
    const result = await execute("tc1", { answer: "A wins on latency" });
    expect(holder.content).toBe("A wins on latency");
    expect(result.terminate).toBe(true);
    expect(result.content[0]?.text).toContain("Answer delivered");
  });
});

describe("ask_caller tool", () => {
  it("captures the question and terminates the run", async () => {
    const holder: { content?: string | undefined; question?: string | undefined } = {};
    const tool = makeAskTool(holder);
    const execute = tool.execute as unknown as (
      id: string,
      params: { question: string },
    ) => Promise<{ content: Array<{ type: string; text: string }>; terminate?: boolean }>;
    const result = await execute("tc1", { question: "Which variant?" });
    expect(holder.question).toBe("Which variant?");
    expect(holder.content).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(result.content[0]?.text).toContain("follow-up");
  });

  it("envelope mentions the ask protocol", () => {
    expect(renderEnvelope(call)).toContain(ASK_TOOL_NAME);
  });
});
