import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileStore } from "../src/core/profileStore.js";

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-profiles-test-"));
}

describe("profile store (YAML, one file per scope)", () => {
  it("round-trips a profile with multiline bootstrap", async () => {
    const dir = await mkTmp();
    const file = path.join(dir, "profiles.yaml");
    const store = new ProfileStore({ userProfilesFile: file });
    await store.set({
      name: "Research",
      description: "gathers evidence",
      bootstrap: "# Research\nCite sources.",
      tools: ["read", "web"],

    });

    // Written as YAML with the normalized name as key.
    const raw = await fs.readFile(file, "utf8");
    expect(raw).toContain("research:");
    expect(raw).toContain("Cite sources.");

    // Addressing: any case/whitespace variant resolves to the same profile.
    const p = await store.get("  RESEARCH ");
    expect(p?.name).toBe("research");
    expect(p?.instructions).toContain("Cite sources.");
    expect(p?.source).toBe("user");
  });

  it("hand-written YAML with block scalar loads correctly", async () => {
    const dir = await mkTmp();
    const file = path.join(dir, "profiles.yaml");
    await fs.writeFile(
      file,
      [
        "profiles:",
        "  research:",
        "    description: web research",
        "    tools: [\"*\"]",
        "",
        "    bootstrap: |",
        "      # Research agent",
        "",
        "      Never estimate anything.",
        "",
      ].join("\n"),
      "utf8",
    );
    const store = new ProfileStore({ userProfilesFile: file });
    const p = await store.get("research");
    expect(p?.instructions).toContain("# Research agent");
    expect(p?.instructions).toContain("Never estimate anything.");
    expect(p?.tools).toEqual(["*"]);
  });

  it("set() preserves other profiles in the same file", async () => {
    const dir = await mkTmp();
    const file = path.join(dir, "profiles.yaml");
    const store = new ProfileStore({ userProfilesFile: file });
    await store.set({ name: "a", description: "A", bootstrap: "aa", tools: []});
    await store.set({ name: "b", description: "B", bootstrap: "bb", tools: []});
    await store.set({ name: "a", description: "A2", bootstrap: "aa2", tools: []});
    const all = await store.list();
    expect(all.map((p) => p.name)).toEqual(["a", "b", "research"]); // research = built-in default
    expect((await store.get("a"))?.description).toBe("A2");
  });

  it("project profiles are additive and hidden until trusted", async () => {
    const dir = await mkTmp();
    const projectRoot = path.join(dir, "repo");
    let trusted = false;
    const store = new ProfileStore({
      userProfilesFile: path.join(dir, "state", "profiles.yaml"),
      projectRoot,
      projectTrusted: () => trusted,
    });

    await fs.mkdir(path.join(projectRoot, "pi-agents"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "pi-agents", "profiles.yaml"),
      [
        "profiles:",
        "  reviewer:",
        "    description: reviews diffs",
        "    tools: [read]",
        "    bootstrap: Review carefully.",
      ].join("\n"),
      "utf8",
    );

    expect(await store.get("reviewer")).toBeUndefined(); // untrusted
    trusted = true;
    const p = await store.get("reviewer");
    expect(p?.source).toBe("project");
    expect(p?.instructions).toBe("Review carefully.");
  });

  it("user profile shadows a same-name project profile", async () => {
    const dir = await mkTmp();
    const projectRoot = path.join(dir, "repo");
    await fs.mkdir(path.join(projectRoot, "pi-agents"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "pi-agents", "profiles.yaml"),
      "profiles:\n  research:\n    description: project\n",
      "utf8",
    );
    const store = new ProfileStore({
      userProfilesFile: path.join(dir, "state", "profiles.yaml"),
      projectRoot,
      projectTrusted: () => true,
    });
    await store.set({
      name: "research",
      description: "user",
      bootstrap: "mine",
      tools: [],

    });

    const p = await store.get("research");
    expect(p?.source).toBe("user");
    expect(p?.description).toBe("user");
    const all = await store.list();
    expect(all.filter((x) => x.name === "research")).toHaveLength(1);
  });

  it("skips invalid names and corrupt files without throwing", async () => {
    const dir = await mkTmp();
    const file = path.join(dir, "profiles.yaml");
    const store = new ProfileStore({ userProfilesFile: file });

    // Corrupt YAML => whole scope empty (defaults still visible).
    await fs.writeFile(file, "profiles: [ this is not : valid: yaml", "utf8");
    expect((await store.list()).every((p) => p.source === "default")).toBe(true);

    // Invalid profile name => that entry skipped, others load.
    await fs.writeFile(
      file,
      "profiles:\n  \"!!bad name!!\":\n    description: evil\n  good:\n    description: fine\n",
      "utf8",
    );
    const all = await store.list();
    expect(all.map((p) => p.name)).toContain("good");
    expect(all.map((p) => p.name)).not.toContain("bad name");
  });

  it("missing file loads the built-in defaults (cold start)", async () => {
    const dir = await mkTmp();
    const store = new ProfileStore({ userProfilesFile: path.join(dir, "nope.yaml") });
    const all = await store.list();
    expect(all.map((p) => p.name)).toContain("research");
    const r = await store.get("research");
    expect(r?.source).toBe("default");
    expect(r?.instructions).toContain("Never estimate");
    expect(r?.tools).toEqual(["*"]);
  });

  it("user profile shadows the built-in default", async () => {
    const dir = await mkTmp();
    const file = path.join(dir, "profiles.yaml");
    const store = new ProfileStore({ userProfilesFile: file });
    await store.set({
      name: "research",
      description: "mine",
      bootstrap: "custom",
      tools: ["read"],

    });
    const r = await store.get("research");
    expect(r?.source).toBe("user");
    expect(r?.description).toBe("mine");
    const all = await store.list();
    expect(all.filter((x) => x.name === "research")).toHaveLength(1);
  });
});
