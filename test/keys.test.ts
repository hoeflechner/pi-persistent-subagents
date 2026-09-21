import { describe, expect, it } from "vitest";
import { buildSessionKey, canonicalProjectId, normalizeAgentName, parseSessionKey } from "../src/core/keys.js";

describe("session keys", () => {
  it("normalizes Windows paths to a stable project id", () => {
    const a = canonicalProjectId("C:\\Users\\dev\\project");
    const b = canonicalProjectId("c:/users/dev/project/");
    expect(a).toBe(b);
  });

  it("separates different projects", () => {
    expect(canonicalProjectId("/repo/one")).not.toBe(canonicalProjectId("/repo/two"));
  });

  it("builds v1 keys with and without namespace", () => {
    const pid = "p_abc";
    expect(buildSessionKey(pid, "research")).toBe("v1:p_abc:research");
    expect(buildSessionKey(pid, "research", "issue-42")).toBe("v1:p_abc:issue-42:research");
  });

  it("round-trips parse", () => {
    const parsed = parseSessionKey("v1:p_abc:issue-42:research");
    expect(parsed).toEqual({
      version: "v1",
      projectId: "p_abc",
      taskNamespace: "issue-42",
      agentName: "research",
    });
    expect(parseSessionKey("bogus:x:y")).toBeUndefined();
  });

  it("normalizes agent name case and rejects junk", () => {
    expect(normalizeAgentName(" Research-Bot ")).toBe("research-bot");
    expect(() => normalizeAgentName("has spaces")).toThrow();
    expect(() => normalizeAgentName("")).toThrow();
  });
});
