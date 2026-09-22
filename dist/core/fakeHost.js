import { randomUUID } from "node:crypto";
/**
 * In-memory fake host for routing tests.
 *
 * Records every prompt/follow-up, enforces the one-active-turn rule, and
 * lets tests control turn completion manually.
 */
export class FakeSessionHost {
    opened = [];
    created = [];
    prompts = [];
    followUps = [];
    aborted = [];
    closed = [];
    /** Keys that currently have an active turn. */
    busy = new Set();
    /** Test hook: how runTurn resolves. */
    turnResolver = (call) => ({
        callId: call.callId,
        sourceSessionKey: call.targetSessionKey,
        outcome: "completed",
        content: `result for ${call.targetAgent}: ${call.prompt.slice(0, 40)}`,
    });
    /** Test hook: block runTurn until releaseTurn() is called. A release that
     * arrives before a gated turn registers its resolver is LATCHED and consumed
     * by the next gated turn — never dropped. */
    gateTurns = false;
    releaseFns = [];
    pendingRelease = false;
    async open(record) {
        this.opened.push(record.sessionKey);
        return { record };
    }
    modelIds = new Map();
    async applyModelId(session, modelId) {
        this.modelIds.set(session.record.sessionKey, modelId);
    }
    async create(spec) {
        this.created.push(spec);
        const record = {
            schemaVersion: 1,
            sessionKey: spec.sessionKey,
            projectId: spec.projectId,
            agentName: spec.profile.name,
            sessionId: randomUUID(),
            sessionPath: `/fake/sessions/${spec.profile.name}.jsonl`,
            displayName: spec.displayName,
            configFingerprint: spec.configFingerprint,
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
        };
        return { record };
    }
    async runTurn(session, call) {
        if (this.busy.has(session.record.sessionKey)) {
            throw new Error(`Agent is already processing: ${session.record.sessionKey} (router violated one-active-turn)`);
        }
        this.busy.add(session.record.sessionKey);
        this.prompts.push(call);
        try {
            if (this.gateTurns) {
                if (this.pendingRelease)
                    this.pendingRelease = false;
                else
                    await new Promise((resolve) => this.releaseFns.push(resolve));
            }
            return this.turnResolver(call);
        }
        finally {
            this.busy.delete(session.record.sessionKey);
        }
    }
    async enqueueFollowUp(session, call) {
        this.followUps.push(call);
    }
    async abort(_session, callId) {
        this.aborted.push(callId);
    }
    async close(session) {
        this.closed.push(session.record.sessionKey);
    }
    releaseTurn() {
        const fn = this.releaseFns.shift();
        if (fn)
            fn();
        else
            this.pendingRelease = true; // latch: no gated turn registered yet
    }
}
//# sourceMappingURL=fakeHost.js.map