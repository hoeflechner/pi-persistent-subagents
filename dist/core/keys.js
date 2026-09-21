import { createHash } from "node:crypto";
import path from "node:path";
/**
 * Session key derivation (architecture.md §7).
 *
 * v1:<project-id>:<agent-name>
 *
 * User scope is implicit: the registry lives in the current OS user's
 * extension data directory. An installation id is stored inside records to
 * detect accidental state-directory sharing (see registry.ts).
 */
export const KEY_SCHEMA_VERSION = "v1";
/**
 * Canonical project identity from the workspace root.
 *
 * MVP: normalized real path, lowercased drive letter on Windows, no trailing
 * separator. Remote-URL joining of separate clones is an open question
 * (open-questions.md #2) and deliberately NOT used here.
 */
export function canonicalProjectId(workspaceRoot) {
    let normalized = path.resolve(workspaceRoot);
    // Windows: case-insensitive drive letter and forward/backslash parity.
    normalized = normalized.replace(/\\/g, "/");
    normalized = normalized.replace(/^([a-z]):/i, (_m, d) => `${d.toLowerCase()}:`);
    normalized = normalized.replace(/\/+$/, "");
    if (normalized === "")
        normalized = "/";
    // Hash to keep keys short and filesystem-safe regardless of path charset.
    const hash = createHash("sha256").update(normalized.toLowerCase()).digest("hex");
    return `p_${hash.slice(0, 16)}`;
}
export function buildSessionKey(projectId, agentName, taskNamespace) {
    const agent = normalizeAgentName(agentName);
    const ns = taskNamespace === undefined || taskNamespace === ""
        ? ""
        : `:${normalizeNamespace(taskNamespace)}`;
    return `${KEY_SCHEMA_VERSION}:${projectId}${ns}:${agent}`;
}
/** Agent names: lowercase, letters/digits/_/-, 1..64 chars. */
export function normalizeAgentName(name) {
    const trimmed = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed)) {
        throw new AgentNameError(`Invalid agent name "${name}". Use 1-64 chars: lowercase letters, digits, '_' or '-'.`);
    }
    return trimmed;
}
function normalizeNamespace(ns) {
    const trimmed = ns.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed)) {
        throw new AgentNameError(`Invalid task namespace "${ns}".`);
    }
    return trimmed;
}
export class AgentNameError extends Error {
}
/** Parse a session key back into parts. Returns undefined for foreign keys. */
export function parseSessionKey(key) {
    const parts = key.split(":");
    if (parts.length < 3 || parts[0] !== KEY_SCHEMA_VERSION)
        return undefined;
    const projectId = parts[1];
    const agentName = parts[parts.length - 1];
    if (!projectId || !agentName)
        return undefined;
    if (parts.length === 3) {
        return { version: parts[0], projectId, agentName };
    }
    return {
        version: parts[0],
        projectId,
        taskNamespace: parts.slice(2, -1).join(":"),
        agentName,
    };
}
//# sourceMappingURL=keys.js.map