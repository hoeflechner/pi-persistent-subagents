import type { AgentProfile } from "./types.js";
/**
 * YAML agent profiles (architecture.md §11).
 *
 * Profile sources — a project directory is NEVER one (a cloned repo must not
 * be able to rewrite agent personas):
 *   <stateDir>/profiles.yaml                 user scope (set()/`/subagents` writes here)
 *   ~/.pi/agents/*.yaml                      agents-dir scope (user-owned files,
 *                                            sorted merge; PI_SUBAGENTS_AGENTS_DIR)
 *   DEFAULT_PROFILES (this module)           built-in defaults
 *
 * Precedence: user > agents-dir files > built-in defaults. Defaults give a
 * fresh install working `research`/`review` agents; any scope can shadow a
 * default by defining the same name.
 *
 * Format:
 *   profiles:
 *     <name>:
 *       description: one-line summary shown to callers
 *       bootstrap: |
 *         multiline seed instructions, injected once at session creation
 *       model: optional model pattern ("auto"/unset mirrors the caller)
 *       tools: [ ... ]        [] or ["*"] = unrestricted
 *
 * A user-scope profile shadows a same-name project-scope profile.
 */
interface ProfileEntry {
    description?: string;
    /** Seed instructions, injected once at session creation. */
    bootstrap?: string;
    model?: string;
    tools?: string[];
}
interface ProfilesFile {
    profiles?: Record<string, ProfileEntry>;
}
/**
 * Built-in profiles shipped with the extension (lowest precedence). Keep in
 * sync with doc/architecture.md §11. Bootstrap text is stored as line arrays
 * to avoid escaping Markdown backticks in template literals.
 */
export declare const DEFAULT_PROFILES: ProfilesFile;
export interface ProfileStoreOptions {
    /** Absolute path to the user-scope YAML file, e.g. <stateDir>/profiles.yaml. */
    userProfilesFile: string;
    /**
     * Directory of user-owned profile files (e.g. ~/.pi/agents). Every *.yaml
     * / *.yml file uses the same `profiles:` schema as profiles.yaml; files
     * merge in sorted order, later files shadow earlier ones. This REPLACED
     * project-scope profiles (pi-agents/profiles.yaml): a project directory is
     * NEVER a profile source — profile provenance is the user plus built-ins
     * only (a cloned folder must not be able to rewrite agent personas).
     */
    agentsDir?: string;
}
export declare class ProfileStore {
    private readonly opts;
    constructor(opts: ProfileStoreOptions);
    private agentsFiles;
    /** Resolve one profile by name. Returns undefined when not defined. */
    get(name: string): Promise<AgentProfile | undefined>;
    /** Built-in profiles, parsed through the same entry pipeline as files. */
    private defaults;
    /** All visible profiles; user shadows agents-dir files, those shadow defaults. */
    list(): Promise<AgentProfile[]>;
    /** Create or update a user-scope profile. */
    set(input: {
        name: string;
        description: string;
        bootstrap: string;
        model?: string;
        tools: string[];
    }): Promise<AgentProfile>;
    /** Parse a profiles file into a name-keyed map. Missing/corrupt => empty. */
    private loadFile;
    /** Validate one raw entry into an AgentProfile; undefined when invalid. */
    private toProfile;
    private readDoc;
}
export {};
