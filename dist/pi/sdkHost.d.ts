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
    /** Turn-scoped authorization: true only while a delegated run awaits this
     * holder. The protocol tools consume an armed holder; an unarmed hit means
     * the session is being driven interactively (UI), where yielding is
     * meaningless — the tool then answers with guidance instead of terminating. */
    armed?: boolean;
}
export interface SdkHostOptions {
    /** Project working directory for child sessions. */
    cwd: string;
    /**
     * Where child Pi session JSONL files live. Omit to use Pi's default
     * (~/.pi/agent/sessions/, organized by cwd) so sessions show up in /resume.
     * Never point this into the project tree.
     */
    sessionDir?: string;
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
    /** Pi session id -> per-session yield/ask holder. Armed only while a
     * runTurn awaits the result; the globally registered protocol tools look
     * holders up here, so delegated runs consume them and interactive drives
     * (same transcript, UI runtime) fall into the guard branch. */
    private readonly holdersBySessionId;
    private readonly protocolYield;
    private readonly protocolAsk;
    /** Holder registered for a live Pi session id (cross-runtime lookup for the
     * extension-registered protocol tools; armed state decides consumption). */
    peekHolder(sessionId: string): YieldHolder | undefined;
    constructor(opts: SdkHostOptions);
    create(spec: NewSessionSpec): Promise<PiSdkSession>;
    open(record: SessionRecord, profile?: NewSessionSpec["profile"], callerModelId?: string): Promise<PiSdkSession>;
    runTurn(managed: ManagedSession, call: CallRecord): Promise<TurnResult>;
    enqueueFollowUp(managed: ManagedSession, call: CallRecord): Promise<void>;
    abort(managed: ManagedSession, _callId: string): Promise<void>;
    close(managed: PiSdkSession): Promise<void>;
    private expect;
    applyModelId(session: ManagedSession, modelId: string): Promise<void>;
    /** Resolve a model pattern (e.g. "claude", "gpt-5.5") against auth/config. */
    resolveModel(pattern: string): Promise<unknown | undefined>;
}
/** Resolve an armed holder for the executing session, or undefined when that
 * session is not inside an awaited delegated turn (interactive UI drive). */
export type HolderResolver = (sessionId: string) => YieldHolder | undefined;
/** The yield_to_caller tool: captures the answer and ends the run. Registered
 * globally by the extension, so it exists in every runtime; only ARMED holders
 * (a delegated turn awaiting its result) consume it — everything else gets
 * guidance instead of a silent failure. */
export declare function makeYieldTool(resolve: HolderResolver): ToolDefinition;
/** The ask_caller tool: captures a question for the caller and ends the run.
 * Global registration and armed-holder semantics as in makeYieldTool. */
export declare function makeAskTool(resolve: HolderResolver): ToolDefinition;
export {};
