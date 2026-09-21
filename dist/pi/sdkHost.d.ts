import { type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CallRecord, SessionRecord, TurnResult } from "../core/types.js";
import type { ManagedSession, NewSessionSpec, SessionHost } from "../core/sessionHost.js";
/**
 * Real SessionHost backed by the Pi SDK (ADR-0001, verified against
 * @earendil-works/pi-coding-agent 0.86.1).
 *
 * Verified API facts this implementation relies on:
 * - createAgentSession({ cwd, sessionManager, model, tools, customTools })
 * - SessionManager.create(cwd, sessionDir) / SessionManager.open(exactPath)
 * - session.prompt(text) resolves when the agent run completes
 * - session.followUp(text) queues into a live streaming session
 * - session.getLastAssistantText() for the no-yield fallback
 * - custom tools via ToolDefinition + typebox schemas; terminate:true stops
 *   the run after the tool batch
 */
export declare const YIELD_TOOL_NAME = "yield_to_caller";
export declare const ASK_TOOL_NAME = "ask_caller";
/** Envelope sent to a managed session for one delegated call. */
export declare function renderEnvelope(call: CallRecord, bootstrap?: string): string;
interface YieldHolder {
    content?: string | undefined;
    /** Set when the agent called ask_caller instead of answering. */
    question?: string | undefined;
}
export interface SdkHostOptions {
    /** Project working directory for child sessions. */
    cwd: string;
    /** Where child Pi session JSONL files live (user-local, NOT the project). */
    sessionDir: string;
    /** Pi agent config dir. Default: ~/.pi/agent (Pi default). */
    agentDir?: string;
    /**
     * Extra custom tools for managed sessions (e.g. the `delegate` tool wired
     * by the extension entry point). Built per session so closures can bind
     * the session key.
     */
    buildExtraTools?: (record: SessionRecord) => ToolDefinition[];
    /** Resolve a profile model string ("provider/id") to a Model. */
    resolveModel?: (pattern: string) => Promise<unknown | undefined>;
    /**
     * Called whenever this host dispatches a turn into a managed session, so
     * the extension can map Pi session ids to delegation identity (session key,
     * ancestry, depth) for nested delegate calls.
     */
    onDispatch?: (sessionId: string, context: {
        sessionKey: string;
        ancestry: string[];
        depth: number;
        rootCallId?: string;
    }) => void;
}
export declare class PiSdkSession implements ManagedSession {
    readonly record: SessionRecord;
    readonly session: AgentSession;
    /** Bootstrap text still owed to this session (injected with its first prompt). */
    bootstrapPending: string;
    readonly yieldHolder: YieldHolder;
    constructor(record: SessionRecord, session: AgentSession, 
    /** Bootstrap text still owed to this session (injected with its first prompt). */
    bootstrapPending: string, yieldHolder: YieldHolder);
}
export declare class PiSdkSessionHost implements SessionHost {
    private readonly opts;
    private runtimePromise;
    /** Live managed sessions by session key, for callback delivery. */
    readonly liveSessions: Map<string, PiSdkSession>;
    constructor(opts: SdkHostOptions);
    create(spec: NewSessionSpec): Promise<PiSdkSession>;
    open(record: SessionRecord, profile?: NewSessionSpec["profile"], callerModelId?: string): Promise<PiSdkSession>;
    runTurn(managed: ManagedSession, call: CallRecord): Promise<TurnResult>;
    enqueueFollowUp(managed: ManagedSession, call: CallRecord): Promise<void>;
    abort(managed: ManagedSession, _callId: string): Promise<void>;
    close(managed: ManagedSession): Promise<void>;
    private expect;
    applyModelId(session: ManagedSession, modelId: string): Promise<void>;
    /** Resolve a model pattern (e.g. "claude", "gpt-5.5") against auth/config. */
    resolveModel(pattern: string): Promise<unknown | undefined>;
}
/** The yield_to_caller tool: captures the answer and ends the run. */
export declare function makeYieldTool(holder: YieldHolder): ToolDefinition;
/** The ask_caller tool: captures a question for the caller and ends the run. */
export declare function makeAskTool(holder: YieldHolder): ToolDefinition;
export {};
