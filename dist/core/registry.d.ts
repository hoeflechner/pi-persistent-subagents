import type { SessionRecord } from "./types.js";
export declare class SessionRegistry {
    private readonly stateDir;
    private readonly store;
    private installationId;
    constructor(stateDir: string);
    /** The user-local state directory backing this registry. */
    dir(): string;
    /** Stable per-installation id; guards against shared state directories. */
    getInstallationId(): Promise<string>;
    get(sessionKey: string): Promise<SessionRecord | undefined>;
    put(record: SessionRecord): Promise<void>;
    touch(sessionKey: string, usedAt: string): Promise<void>;
    remove(sessionKey: string): Promise<SessionRecord | undefined>;
    list(): Promise<SessionRecord[]>;
    /**
     * Validate records against on-disk reality (architecture.md §14 doctor).
     * Missing session files are reported, never silently re-pointed.
     */
    doctor(): Promise<DoctorReport>;
}
export interface DoctorIssue {
    sessionKey: string;
    problem: string;
}
export interface DoctorReport {
    ok: boolean;
    issues: DoctorIssue[];
}
