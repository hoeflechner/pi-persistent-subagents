# Persistent Subagents for Pi

This directory describes a Pi extension that gives agents stable, persistent
named sessions. Names such as `research`, `plan`, and `code` are examples, not a
fixed set.

## Documents

- [Architecture](architecture.md): requirements, routing, protocol, lifecycle,
  security, testing, and delivery plan.
- [ADR 0001](adr-0001-session-hosting.md): why the MVP should host Pi SDK
  sessions in-process while keeping an RPC worker adapter possible.
- [Existing solutions](existing-solutions.md): verified upstream and community
  alternatives and the gaps relative to this proposal.
- [Open questions](open-questions.md): product decisions still needed from the
  user.

## Current recommendation

Build a TypeScript Pi extension with a broker that owns one persistent SDK
session per stable session key. Start with the key:

```text
local user + canonical project identity + agent profile
```

Mappings live in user-local extension state, never in the shared project. Every
key has one FIFO mailbox and at most one active turn. Delegation immediately
returns a receipt; completion is later injected into the caller's chat as a
correlated callback message. A same-key call queues a follow-up in the current
session instead of creating another session.

This default is an assumption pending the decisions in
[Open questions](open-questions.md).