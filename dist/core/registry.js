import { randomUUID } from "node:crypto";
import path from "node:path";
import { createJsonStore } from "./jsonStore.js";
export class SessionRegistry {
    stateDir;
    store;
    installationId;
    constructor(stateDir) {
        this.stateDir = stateDir;
        this.store = createJsonStore(path.join(stateDir, "registry.json"), () => ({
            schemaVersion: 1,
            installationId: "",
            sessions: {},
        }));
    }
    /** The user-local state directory backing this registry. */
    dir() {
        return this.stateDir;
    }
    /** Stable per-installation id; guards against shared state directories. */
    async getInstallationId() {
        if (this.installationId)
            return this.installationId;
        await this.store.update((state) => {
            if (!state.installationId)
                state.installationId = randomUUID();
        });
        const state = await this.store.read();
        this.installationId = state.installationId;
        return this.installationId;
    }
    async get(sessionKey) {
        const state = await this.store.read();
        return state.sessions[sessionKey];
    }
    async put(record) {
        await this.getInstallationId();
        await this.store.update((state) => {
            state.sessions[record.sessionKey] = record;
        });
    }
    async touch(sessionKey, usedAt) {
        await this.store.update((state) => {
            const existing = state.sessions[sessionKey];
            if (existing)
                existing.lastUsedAt = usedAt;
        });
    }
    async remove(sessionKey) {
        let removed;
        await this.store.update((state) => {
            removed = state.sessions[sessionKey];
            if (removed)
                delete state.sessions[sessionKey];
        });
        return removed;
    }
    async list() {
        const state = await this.store.read();
        return Object.values(state.sessions);
    }
    /**
     * Validate records against on-disk reality (architecture.md §14 doctor).
     * Missing session files are reported, never silently re-pointed.
     */
    async doctor() {
        const state = await this.store.read();
        const issues = [];
        for (const record of Object.values(state.sessions)) {
            if (!record.sessionPath || !path.isAbsolute(record.sessionPath)) {
                issues.push({ sessionKey: record.sessionKey, problem: "session path is not absolute" });
                continue;
            }
            if (!await exists(record.sessionPath)) {
                issues.push({
                    sessionKey: record.sessionKey,
                    problem: `session file missing: ${record.sessionPath}`,
                });
            }
        }
        return { ok: issues.length === 0, issues };
    }
}
async function exists(p) {
    try {
        await (await import("node:fs/promises")).access(p);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=registry.js.map