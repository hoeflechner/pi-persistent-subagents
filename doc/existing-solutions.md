# Existing Solutions Research

Research date: 2026-10-16

## Conclusion

No verified upstream Pi extension was found that exactly implements stable
project-scoped dynamic agent sessions, fire-and-forget callback delivery,
same-session follow-ups, and restart persistence.

There are, however, three important reference points. Oh My Pi is the closest
existing product and may be preferable if adopting a Pi fork is acceptable.
Upstream Pi's durable harness work contains much of the deeper model, but is not
the same as a ready coding-agent extension API.

## 1. Official Pi subagent example

Location in upstream Pi:

```text
packages/coding-agent/examples/extensions/subagent/
```

Verified behavior:

- Defines Markdown agents and a delegation tool.
- Supports single, parallel, and chained calls.
- Streams events, gathers usage, propagates abort, and limits concurrency.
- Starts one subprocess per invocation with:

```ts
const args = ["--mode", "json", "-p", "--no-session"];
```

Gap:

- Every invocation is isolated and sessionless.
- There is no durable role-to-session registry.
- No fixed repeated routing to the same role transcript.
- No durable asynchronous callback outbox or same-agent follow-up rule.

It remains the best upstream reference for role files, rendering, abort
propagation, concurrency limits, and security confirmation.

## 2. Oh My Pi

Repository: <https://github.com/can1357/oh-my-pi>

Oh My Pi is an MIT-licensed fork of Pi, not a small extension for upstream Pi.
Its current README documents:

- First-class subagents through a `task` tool.
- Isolated worktrees and per-worker tool surfaces.
- Typed, schema-validated results returned to the parent.
- An Agent Hub for transcripts, steering, reviving, and killing workers.
- A `hub` tool for messaging agents and waiting/cancelling jobs.
- A `/vibe` mode that drives persistent `fast` and `good` worker sessions.
- Agent-addressable results through `agent://` paths.
- SDK and RPC entry points similar to Pi.

Fit:

- It demonstrably solves much more of subagent supervision than the official
  example.
- `/vibe` is especially close to stable persistent worker sessions.
- Typed parent results and peer communication overlap the callback requirement.

Unverified or different from this proposal:

- The documentation does not establish the proposed user-local, project-scoped
  mapping for arbitrary named agent profiles.
- Same-agent calls resolving locally in the currently running conversation are
  not documented as an invariant.
- Its task fan-out emphasizes isolated workers/worktrees; exact persistence and
  identity semantics for ordinary `task` workers need source-level validation.
- Adopting it means adopting a large Pi fork and its runtime/tooling surface,
  not installing a focused upstream extension.

Decision implication:

- Evaluate Oh My Pi before implementing if changing from upstream Pi is an
  option. If upstream compatibility is required, treat it as design evidence,
  not a dependency.

## 3. Upstream AgentHarness and pico designs

Upstream Pi contains an implemented durable `AgentHarness` and a separate pico
v3 design under `packages/agent/`.

Relevant verified AgentHarness features:

- Named durable `AgentLane` conversations in one session.
- Persistent operation state and explicit crash recovery.
- One writer per session and one active operation per lane.
- Durable inboxes, cancellation, result records, and exact operation IDs.
- JSONL and SQLite session backends.

Relevant pico v3 design concepts:

- A subagent is an owned conversation.
- `run`, `spawn`, `send`, `status`, `wait`, and `stop` commands.
- Durable ownership, input receipts, task recovery, and wait-cycle rejection.
- No separate subagent registry because conversation IDs are durable.

Limitations:

- pico v3 explicitly describes itself as a design; some interfaces are
  provisional and examples are not package exports.
- AgentHarness is a lower-level package and is not the ordinary coding-agent
  extension session API.
- Integrating either directly would be a larger architectural commitment than
  hosting existing coding-agent `AgentSession` instances.

Use these designs for invariants and future evolution, especially durable work
receipts, ownership, cancellation, cycle checks, and one-writer rules.

## 4. wshobson/agents

Repository: <https://github.com/wshobson/agents>

This is a large multi-harness marketplace. Its Pi generator emits skills,
prompt templates, and Markdown agents using Pi's reference subagent format.
It provides many role definitions and orchestrator prompts, but inherits the
official invocation model. It is content and workflow packaging, not a verified
persistent session broker.

## 5. Other search candidates

Broad repository searches surfaced `senpi`, `pi-as-mcp`, and `pi-stuff`, among
others. The search metadata was noisy and sometimes implausible. None was
verified at source level to satisfy this design, so they are not treated as
existing solutions.

## Build-versus-adopt checkpoint

Before implementation, choose one path:

| Path | Best when | Main cost |
|---|---|---|
| Upstream Pi extension proposed here | Upstream compatibility and exact role routing matter | Build broker and lifecycle logic |
| Oh My Pi | Its larger integrated subagent platform is acceptable | Adopt and track a substantial fork |
| Upstream durable harness integration | Durable operations and lanes are strategic requirements | Larger, lower-level integration with evolving APIs |

## Sources

- Pi extension documentation and official subagent example.
- Pi RPC, SDK, and session format documentation.
- Pi `AgentSession`, RPC client/mode, concurrency tests, and SDK examples.
- Pi `packages/agent/docs/harness.md` and `docs/pico/pico-v3.md`.
- Oh My Pi README.
- wshobson/agents README and Pi harness notes.