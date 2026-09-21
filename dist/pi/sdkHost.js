import { createAgentSession, ModelRuntime, resolveModelScopeWithDiagnostics, SessionManager, } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
export const YIELD_TOOL_NAME = "yield_to_caller";
export const ASK_TOOL_NAME = "ask_caller";
/** Envelope sent to a managed session for one delegated call. */
export function renderEnvelope(call, bootstrap) {
    const header = `[delegated call ${call.callId}] from "${call.caller.label}" ` +
        `(agent "${call.targetAgent}"). When your answer is ready, you MUST call ` +
        `yield_to_caller with the complete result. That call is your answer. ` +
        `If you are missing information only the caller or the user can provide, ` +
        `call ask_caller with your question instead of guessing — the answer ` +
        `arrives as a follow-up message in this session.`;
    const parts = [];
    if (bootstrap)
        parts.push(bootstrap.trim());
    parts.push(header, "", call.prompt);
    return parts.join("\n\n");
}
export class PiSdkSession {
    record;
    session;
    bootstrapPending;
    yieldHolder;
    constructor(record, session, 
    /** Bootstrap text still owed to this session (injected with its first prompt). */
    bootstrapPending, yieldHolder) {
        this.record = record;
        this.session = session;
        this.bootstrapPending = bootstrapPending;
        this.yieldHolder = yieldHolder;
    }
}
export class PiSdkSessionHost {
    opts;
    runtimePromise;
    /** Live managed sessions by session key, for callback delivery. */
    liveSessions = new Map();
    constructor(opts) {
        this.opts = opts;
    }
    async create(spec) {
        // Undefined sessionDir => Pi default (~/.pi/agent/sessions/, by cwd).
        const sessionManager = SessionManager.create(this.opts.cwd, this.opts.sessionDir);
        const holder = {};
        // Model policy: explicit pattern wins; "auto"/unset mirrors the caller's
        // model captured at delegate time.
        const pattern = spec.profile.model && spec.profile.model !== "auto"
            ? spec.profile.model
            : spec.callerModelId;
        const model = pattern ? await this.resolveModel(pattern) : undefined;
        // Tool policy: empty list or "*" means "no restriction" -> omit the
        // allowlist so Pi grants its default built-in tools. yield_to_caller and
        // ask_caller are always granted via customTools regardless of the
        // allowlist.
        const unrestricted = spec.profile.tools.length === 0 || spec.profile.tools.includes("*");
        const { session } = await createAgentSession({
            cwd: this.opts.cwd,
            ...(this.opts.agentDir !== undefined ? { agentDir: this.opts.agentDir } : {}),
            sessionManager,
            ...(model !== undefined ? { model: model } : {}),
            ...(unrestricted
                ? {}
                : {
                    tools: [
                        ...new Set([...spec.profile.tools, YIELD_TOOL_NAME, ASK_TOOL_NAME]),
                    ],
                }),
            customTools: [
                makeYieldTool(holder),
                makeAskTool(holder),
                ...(this.opts.buildExtraTools?.(placeholderRecord(spec)) ?? []),
            ],
        });
        const record = {
            schemaVersion: 1,
            sessionKey: spec.sessionKey,
            projectId: spec.projectId,
            agentName: spec.profile.name,
            sessionId: session.sessionId,
            sessionPath: session.sessionFile ?? "",
            displayName: spec.displayName,
            configFingerprint: spec.configFingerprint,
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
        };
        if (!record.sessionPath) {
            throw new Error("Pi session file unavailable immediately after creation");
        }
        const managed = new PiSdkSession(record, session, spec.profile.instructions, holder);
        this.liveSessions.set(record.sessionKey, managed);
        return managed;
    }
    async open(record, profile, callerModelId) {
        const sessionManager = SessionManager.open(record.sessionPath);
        const holder = {};
        // Re-apply the profile's tool policy to the reopened session; omitting
        // the allowlist means Pi's default built-ins (same as "*").
        const unrestricted = !profile || profile.tools.length === 0 || profile.tools.includes("*");
        const pattern = profile && profile.model && profile.model !== "auto"
            ? profile.model
            : callerModelId;
        const model = pattern ? await this.resolveModel(pattern) : undefined;
        const { session } = await createAgentSession({
            cwd: this.opts.cwd,
            ...(this.opts.agentDir !== undefined ? { agentDir: this.opts.agentDir } : {}),
            sessionManager,
            ...(model !== undefined ? { model: model } : {}),
            ...(unrestricted
                ? {}
                : {
                    tools: [
                        ...new Set([...profile.tools, YIELD_TOOL_NAME, ASK_TOOL_NAME]),
                    ],
                }),
            customTools: [
                makeYieldTool(holder),
                makeAskTool(holder),
                ...(this.opts.buildExtraTools?.(record) ?? []),
            ],
        });
        // An opened session already has its transcript; bootstrap is not re-sent
        // (architecture.md §11.1). Drift is surfaced by inspect/doctor instead.
        const managed = new PiSdkSession(record, session, "", holder);
        this.liveSessions.set(record.sessionKey, managed);
        return managed;
    }
    async runTurn(managed, call) {
        const s = this.expect(managed);
        s.yieldHolder.content = undefined;
        s.yieldHolder.question = undefined;
        this.opts.onDispatch?.(s.session.sessionId, {
            sessionKey: call.targetSessionKey,
            ancestry: call.ancestry,
            depth: call.depth,
            rootCallId: call.rootCallId,
        });
        const envelope = renderEnvelope(call, s.bootstrapPending || undefined);
        s.bootstrapPending = "";
        try {
            await s.session.prompt(envelope);
        }
        catch (err) {
            return {
                callId: call.callId,
                sourceSessionKey: call.targetSessionKey,
                outcome: "failed",
                content: "",
                error: err.message,
            };
        }
        if (s.yieldHolder.question !== undefined) {
            return {
                callId: call.callId,
                sourceSessionKey: call.targetSessionKey,
                outcome: "needs_input",
                content: s.yieldHolder.question,
                question: s.yieldHolder.question,
            };
        }
        if (s.yieldHolder.content !== undefined) {
            return {
                callId: call.callId,
                sourceSessionKey: call.targetSessionKey,
                outcome: "completed",
                content: s.yieldHolder.content,
            };
        }
        const fallback = s.session.getLastAssistantText() ?? "";
        return {
            callId: call.callId,
            sourceSessionKey: call.targetSessionKey,
            outcome: "completed",
            content: fallback,
            protocolWarning: true,
        };
    }
    async enqueueFollowUp(managed, call) {
        const s = this.expect(managed);
        this.opts.onDispatch?.(s.session.sessionId, {
            sessionKey: call.targetSessionKey,
            ancestry: call.ancestry,
            depth: call.depth,
            rootCallId: call.rootCallId,
        });
        await s.session.followUp(`[follow-up ${call.callId}] ${call.prompt}\n\n` +
            `Answer with yield_to_caller when done (or ask_caller if you still need input).`);
    }
    async abort(managed, _callId) {
        await this.expect(managed).session.abort();
    }
    async close(managed) {
        const s = this.expect(managed);
        this.liveSessions.delete(s.record.sessionKey);
        s.session.dispose();
    }
    expect(managed) {
        if (!(managed instanceof PiSdkSession)) {
            throw new Error("session not created by this host");
        }
        return managed;
    }
    async applyModelId(session, modelId) {
        const s = this.expect(session);
        const model = await this.resolveModel(modelId);
        if (model !== undefined) {
            await s.session.setModel(model);
        }
    }
    /** Resolve a model pattern (e.g. "claude", "gpt-5.5") against auth/config. */
    async resolveModel(pattern) {
        if (this.opts.resolveModel)
            return this.opts.resolveModel(pattern);
        this.runtimePromise ??= ModelRuntime.create();
        const runtime = await this.runtimePromise;
        const { scopedModels } = await resolveModelScopeWithDiagnostics([pattern], runtime);
        return scopedModels[0]?.model;
    }
}
/** The yield_to_caller tool: captures the answer and ends the run. */
export function makeYieldTool(holder) {
    return {
        name: YIELD_TOOL_NAME,
        label: "Yield answer",
        description: "Return your complete answer to the session that delegated this task to " +
            "you. Call this exactly once, as your final action. The text you pass " +
            "becomes your entire answer, so include everything the caller needs.",
        promptSnippet: "Call yield_to_caller(answer) as your final action to return results to the caller.",
        promptGuidelines: [
            "yield_to_caller is your answer channel: pass the complete result, not a summary of what you will do next.",
            "Always finish by calling yield_to_caller with your complete answer. Never end a turn without it — text you write without the tool call is lost and the caller never receives it.",
        ],
        parameters: Type.Object({
            answer: Type.String({ description: "The complete answer for the caller." }),
        }),
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async (_id, params) => {
            holder.content = params.answer;
            return {
                content: [{ type: "text", text: "Answer delivered to caller. You may stop." }],
                details: undefined,
                terminate: true,
            };
        },
    };
}
/** The ask_caller tool: captures a question for the caller and ends the run. */
export function makeAskTool(holder) {
    return {
        name: ASK_TOOL_NAME,
        label: "Ask caller",
        description: "Ask the session that delegated this task a question you cannot answer " +
            "without the caller or the user. Call this instead of guessing or " +
            "yielding an incomplete answer. The answer arrives as a follow-up " +
            "message in this same session, where you keep all your context.",
        promptSnippet: "Call ask_caller(question) when only the caller or user can supply missing information.",
        promptGuidelines: [
            "Never estimate or invent information only the caller/user could provide — call ask_caller instead.",
            "ask_caller ends your turn; do not also call yield_to_caller in the same turn. Make the question complete and self-contained: the caller does not see your context.",
        ],
        parameters: Type.Object({
            question: Type.String({
                description: "The question for the caller (or, via the caller, the user).",
            }),
        }),
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async (_id, params) => {
            holder.question = params.question;
            return {
                content: [
                    {
                        type: "text",
                        text: "Question sent to caller. End your turn now; the answer arrives " +
                            "as a follow-up message in this session.",
                    },
                ],
                details: undefined,
                terminate: true,
            };
        },
    };
}
function placeholderRecord(spec) {
    // Extra tools are built before the session exists; they receive the spec
    // identity and the real record is patched by the router after creation.
    return {
        schemaVersion: 1,
        sessionKey: spec.sessionKey,
        projectId: spec.projectId,
        agentName: spec.profile.name,
        sessionId: "",
        sessionPath: "",
        displayName: spec.displayName,
        configFingerprint: spec.configFingerprint,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=sdkHost.js.map