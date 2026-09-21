# ADR 0001: Host MVP Sessions with the Pi SDK

- Status: Proposed
- Date: 2026-10-16

## Context

An ordinary Pi extension context represents one current interactive session.
Calling session-switching APIs replaces that runtime; it does not provide a
collection of concurrently addressable managed sessions. The broker therefore
needs a separate session-hosting boundary.

Pi provides two viable boundaries:

1. Multiple independent SDK `AgentSession` instances backed by persistent
   `SessionManager` instances.
2. One long-lived `pi --mode rpc` subprocess per live managed session.

The official Pi subagent example does neither persistently: it launches a fresh
print/JSON process with `--no-session` for each invocation.

## Decision

Use independently created in-process SDK sessions for the MVP. Hide them behind
`SessionHost` so RPC workers can be introduced without changing delegation,
routing, registry records, or tests.

Use `SessionManager.create()` for a new managed session and
`SessionManager.open(exactPath)` when reopening a mapped session. Give every
session a broker-owned FIFO because a normal second `prompt()` while streaming
is rejected.

Store project-to-session mappings, call receipts, and callback outbox state in
the current user's extension data directory. None of this state belongs in the
shared project checkout.

## Rationale

- Pi recommends direct SDK use for Node/TypeScript applications unless process
  isolation is needed.
- `prompt()` has a direct completion promise, reducing protocol machinery.
- Typed events and direct object ownership simplify cancellation and tests.
- Several independent sessions can coexist when separately created.
- No subprocess supervision, JSONL framing, stderr handling, or request map is
  needed for the first implementation.

## Consequences

### Positive

- Smaller MVP and lower per-session overhead.
- Typed access to session APIs and events.
- Straightforward exact-file persistence and lazy reopening.
- One process-level lifecycle to test.

### Negative

- A faulty managed session shares the extension process.
- CPU, memory, globals, and loaded extension code share one trust boundary.
- Resource loading must be scoped so child sessions receive only intended role
  prompts and tools.
- Hard termination of a stuck provider or tool is weaker than killing a worker.

## RPC alternative

Use long-lived RPC workers when hard process isolation, independent extension
loading, or forced termination becomes a requirement. Persistent workers must
omit `--no-session` and should use a controlled `--session-dir`.

RPC implementation requirements:

- Use Pi's typed `RpcClient` where compatible.
- Frame records strictly on LF-delimited JSONL. Node's `readline` is not valid
  because it also splits Unicode line separators.
- Correlate commands with request IDs.
- Treat a successful `prompt` response as acceptance only.
- Resolve a turn on `agent_settled`, not `agent_end`.
- Reopen or switch to the exact registered session after worker restart.
- Capture and bound stderr; supervise process exit and abort propagation.

## Revisit triggers

Reconsider RPC if any of these becomes true:

- Agent profiles need mutually untrusted extension/tool code.
- A role must be forcibly terminated without risking the broker.
- SDK globals or resource loaders cannot be isolated correctly.
- Memory retention from several in-process sessions is unacceptable.
- Different roles require incompatible runtime versions or environments.