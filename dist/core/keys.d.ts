/**
 * Session key derivation (architecture.md §7).
 *
 * v1:<project-id>:<agent-name>
 *
 * User scope is implicit: the registry lives in the current OS user's
 * extension data directory. An installation id is stored inside records to
 * detect accidental state-directory sharing (see registry.ts).
 */
export declare const KEY_SCHEMA_VERSION = "v1";
/**
 * Canonical project identity from the workspace root.
 *
 * MVP: normalized real path, lowercased drive letter on Windows, no trailing
 * separator. Remote-URL joining of separate clones is an open question
 * (open-questions.md #2) and deliberately NOT used here.
 */
export declare function canonicalProjectId(workspaceRoot: string): string;
export declare function buildSessionKey(projectId: string, agentName: string, taskNamespace?: string): string;
/** Agent names: lowercase, letters/digits/_/-, 1..64 chars. */
export declare function normalizeAgentName(name: string): string;
export declare class AgentNameError extends Error {
}
/** Parse a session key back into parts. Returns undefined for foreign keys. */
export declare function parseSessionKey(key: string): {
    version: string;
    projectId: string;
    taskNamespace?: string;
    agentName: string;
} | undefined;
