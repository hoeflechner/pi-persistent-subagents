import fs from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { normalizeAgentName } from "./keys.js";
/**
 * Built-in profiles shipped with the extension (lowest precedence). Keep in
 * sync with doc/architecture.md §11. Bootstrap text is stored as line arrays
 * to avoid escaping Markdown backticks in template literals.
 */
export const DEFAULT_PROFILES = {
    profiles: {
        research: {
            description: "web research: multi-source investigation, verification, comparisons. Use for any web research beyond a single known-URL fetch.",
            tools: ["*"],
            bootstrap: [
                "# Research agent",
                "",
                "You are a persistent research assistant for this project. You have memory of",
                "previous tasks. Your job is to reach a **verified, complete picture** of the",
                "question asked — not a first draft of an answer.",
                "",
                "## Research loop — do not stop early",
                "",
                "1. Decompose the task into concrete sub-questions.",
                "2. Research each one with your tools (`web_search`, `fetch_content`,",
                "   `get_search_content`, `read`, `grep`). Search, read the actual source,",
                "   extract the fact, move on.",
                "3. After each round, ask: *can I answer every sub-question from evidence I",
                "   personally retrieved?* If not, keep researching. Do not settle for a",
                "   partial picture — iterate until every sub-question is covered or",
                "   demonstrably unanswerable.",
                "4. Cross-check load-bearing claims against a second independent source.",
                "",
                "## Hard rules",
                "",
                "- **Never estimate, extrapolate, or rely on model knowledge.** Every fact,",
                "  number, version, name, and URL in your answer must come from a source you",
                "  actually fetched or a file you actually read during this session.",
                "- If something cannot be verified, say so explicitly (\"not verifiable with",
                "  available tools\") — never fill the gap with a plausible guess.",
                "- If only the caller or the user could supply the missing piece (which",
                "  product variant, budget, preference, scope), call `ask_caller` with a",
                "  precise question instead of guessing — the answer arrives as a",
                "  follow-up in this session and you continue where you left off.",
                "- Cite the source (URL or file path) inline for every claim.",
                "- Prefer primary sources (official docs, repos, specs) over blogs and",
                "  summaries.",
                "",
                "## Findings file (your durable notebook)",
                "",
                "- Keep your research in `research/<topic>.md` **in the project** (your",
                "  working directory; create the folder if missing), one file per **broad",
                "  topic** (kebab-case, e.g. `research/mi-band-nfc-hacks.md`, not",
                "  `research/mi-band-7-nfc-2026-09.md`). Related follow-up questions belong",
                "  in the same file — do not create a new file per question.",
                "- Before researching, list `research/` and grep it: if a file",
                "  already covers the topic (or a slightly different angle of the same",
                "  topic), extend that file instead of starting a new one. Rename the",
                "  file (and update its title) if the topic's scope shifted.",
                "- Split into a new file only when the subject genuinely diverges",
                "  (different product, different technology). When in doubt, extend.",
                "- File structure per topic file:",
                "  `# <Topic>` title, then `## Findings` with dated sections",
                "  (`### YYYY-MM-DD — <question>`), each finding citing its source",
                "  inline, then a `## Sources` section listing every URL used, deduped.",
                "- Append to existing files; never rewrite earlier dated sections.",
                "- Mention the findings file path in your answer so the caller can point",
                "  the user to it.",
                "",
                "## Answer format",
                "",
                "- **English only**, regardless of the language of the question.",
                "- **Short but precise**: bullet points, exact numbers, exact names. No",
                "  filler, no restating the question, no hedging prose.",
                "- Structure: direct answer first, then key evidence bullets, then explicitly",
                "  marked gaps (\"Unverified: ...\") if any remain.",
                "- Sources: cite claims with URLs in the answer.",
            ].join("\n"),
        },
    },
};
export class ProfileStore {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    projectFile() {
        if (!this.opts.projectRoot)
            return undefined;
        return path.join(this.opts.projectRoot, "pi-agents", "profiles.yaml");
    }
    /** Resolve one profile by name. Returns undefined when not defined. */
    async get(name) {
        let normalized;
        try {
            normalized = normalizeAgentName(name);
        }
        catch {
            return undefined;
        }
        const user = await this.loadFile(this.opts.userProfilesFile, "user");
        const fromUser = user.get(normalized);
        if (fromUser)
            return fromUser;
        const pf = this.projectFile();
        if (pf && (this.opts.projectTrusted?.() ?? false)) {
            const project = await this.loadFile(pf, "project");
            const fromProject = project.get(normalized);
            if (fromProject)
                return fromProject;
        }
        return this.defaults().get(normalized);
    }
    /** Built-in profiles, parsed through the same entry pipeline as files. */
    defaults() {
        const out = new Map();
        for (const [rawName, entry] of Object.entries(DEFAULT_PROFILES.profiles ?? {})) {
            const profile = this.toProfile(rawName, entry, "default");
            if (profile)
                out.set(profile.name, profile);
        }
        return out;
    }
    /** All visible profiles; user shadows project, project shadows defaults. */
    async list() {
        const byName = this.defaults();
        const pf = this.projectFile();
        if (pf && (this.opts.projectTrusted?.() ?? false)) {
            for (const [name, p] of await this.loadFile(pf, "project")) {
                byName.set(name, p);
            }
        }
        for (const [name, p] of await this.loadFile(this.opts.userProfilesFile, "user")) {
            byName.set(name, p);
        }
        return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    /** Create or update a user-scope profile. */
    async set(input) {
        const name = normalizeAgentName(input.name);
        const doc = (await this.readDoc(this.opts.userProfilesFile)) ?? {};
        if (!doc.profiles)
            doc.profiles = {};
        const entry = {
            description: input.description,
            bootstrap: input.bootstrap,
            tools: input.tools,
            ...(input.model !== undefined ? { model: input.model } : {}),
        };
        doc.profiles[name] = entry;
        await fs.mkdir(path.dirname(this.opts.userProfilesFile), { recursive: true });
        await fs.writeFile(this.opts.userProfilesFile, stringify(doc, { lineWidth: 0 }), "utf8");
        return {
            name,
            description: input.description,
            instructions: input.bootstrap,
            tools: input.tools,
            source: "user",
            ...(input.model !== undefined ? { model: input.model } : {}),
        };
    }
    /** Parse a profiles file into a name-keyed map. Missing/corrupt => empty. */
    async loadFile(file, source) {
        const out = new Map();
        const doc = await this.readDoc(file);
        if (!doc?.profiles)
            return out;
        for (const [rawName, entry] of Object.entries(doc.profiles)) {
            const profile = this.toProfile(rawName, entry, source);
            if (profile)
                out.set(profile.name, profile);
        }
        return out;
    }
    /** Validate one raw entry into an AgentProfile; undefined when invalid. */
    toProfile(rawName, entry, source) {
        let name;
        try {
            name = normalizeAgentName(rawName);
        }
        catch {
            return undefined; // invalid name: skip; doctor reports it
        }
        if (!entry || typeof entry !== "object")
            return undefined;
        return {
            name,
            description: entry.description ?? "",
            instructions: entry.bootstrap ?? "",
            tools: entry.tools ?? [],
            source,
            ...(entry.model !== undefined ? { model: entry.model } : {}),
        };
    }
    async readDoc(file) {
        let raw;
        try {
            raw = await fs.readFile(file, "utf8");
        }
        catch {
            return undefined; // no file for this scope
        }
        try {
            return parse(raw);
        }
        catch {
            return undefined; // corrupt YAML: skip the whole scope; doctor reports it
        }
    }
}
//# sourceMappingURL=profileStore.js.map