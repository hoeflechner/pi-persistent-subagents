import { randomUUID } from "node:crypto";
import path from "node:path";
import { createJsonStore, type JsonStore } from "./jsonStore.js";
import type { SessionRecord } from "./types.js";

/**
 * Durable session registry (architecture.md §6).
 *
 * Lives in user-local extension state, NEVER in the project tree.
 * Layout: <stateDir>/registry.json plus <stateDir>/installation-id.
 */

interface RegistryFile {
  schemaVersion: 1;
  installationId: string;
  sessions: Record<string, SessionRecord>;
}

export class SessionRegistry {
  private readonly store: JsonStore<RegistryFile>;
  private installationId: string | undefined;

  constructor(private readonly stateDir: string) {
    this.store = createJsonStore<RegistryFile>(path.join(stateDir, "registry.json"), () => ({
      schemaVersion: 1,
      installationId: "",
      sessions: {},
    }));
  }

  /** The user-local state directory backing this registry. */
  dir(): string {
    return this.stateDir;
  }

  /** Stable per-installation id; guards against shared state directories. */
  async getInstallationId(): Promise<string> {
    if (this.installationId) return this.installationId;
    await this.store.update((state) => {
      if (!state.installationId) state.installationId = randomUUID();
    });
    const state = await this.store.read();
    this.installationId = state.installationId;
    return this.installationId;
  }

  async get(sessionKey: string): Promise<SessionRecord | undefined> {
    const state = await this.store.read();
    return state.sessions[sessionKey];
  }

  async put(record: SessionRecord): Promise<void> {
    await this.getInstallationId();
    await this.store.update((state) => {
      state.sessions[record.sessionKey] = record;
    });
  }

  async touch(sessionKey: string, usedAt: string): Promise<void> {
    await this.store.update((state) => {
      const existing = state.sessions[sessionKey];
      if (existing) existing.lastUsedAt = usedAt;
    });
  }

  async remove(sessionKey: string): Promise<SessionRecord | undefined> {
    let removed: SessionRecord | undefined;
    await this.store.update((state) => {
      removed = state.sessions[sessionKey];
      if (removed) delete state.sessions[sessionKey];
    });
    return removed;
  }

  async list(): Promise<SessionRecord[]> {
    const state = await this.store.read();
    return Object.values(state.sessions);
  }

  /**
   * Validate records against on-disk reality (architecture.md §14 doctor).
   * Missing session files are reported, never silently re-pointed.
   */
  async doctor(): Promise<DoctorReport> {
    const state = await this.store.read();
    const issues: DoctorIssue[] = [];
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

export interface DoctorIssue {
  sessionKey: string;
  problem: string;
}

export interface DoctorReport {
  ok: boolean;
  issues: DoctorIssue[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await (await import("node:fs/promises")).access(p);
    return true;
  } catch {
    return false;
  }
}
