import type { AgentProfile } from "./types.js";
/**
 * YAML agent profiles (architecture.md §11).
 *
 * One YAML file per scope holds all profiles of that scope:
 *   <stateDir>/profiles.yaml               user scope   (always trusted)
 *   <projectRoot>/pi-agents/profiles.yaml  project scope (additive, untrusted
 *                                          until the project is trusted)
 *
 * Precedence: user > project > built-in defaults (DEFAULT_PROFILES below).
 * Defaults give a fresh install a working `research` agent; any scope can
 * shadow a default by defining the same name.
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
    /** Repository root, when a project is open. */
    projectRoot?: string;
    /** Whether project-declared profiles are trusted for this project. */
    projectTrusted?: () => boolean;
}
export declare class ProfileStore {
    private readonly opts;
    constructor(opts: ProfileStoreOptions);
    private projectFile;
    /** Resolve one profile by name. Returns undefined when not defined. */
    get(name: string): Promise<AgentProfile | undefined>;
    /** Built-in profiles, parsed through the same entry pipeline as files. */
    private defaults;
    /** All visible profiles; user shadows project, project shadows defaults. */
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
