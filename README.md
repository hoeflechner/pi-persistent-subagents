# pi-persistent-subagents

Pi coding-agent extension: persistent, project-scoped named agent sessions
with fire-and-forget delegation and durable callbacks.

Design docs live in [`doc/`](doc/README.md) — start with
[`doc/architecture.md`](doc/architecture.md).

## Status

Milestone 1 complete: the **routing core** (session keys, durable registry,
call/outbox store, FIFO mailboxes, delegation router) is implemented and
tested against a fake `SessionHost`. No Pi SDK wiring yet — that is
Milestone 2–3 (see architecture.md delivery plan).

## Key invariants (tested)

- `delegate()` returns a receipt immediately; the turn runs later.
- One session per `v1:<project-id>:<agent>` key, created lazily, reused
  across calls; state lives only in user-local extension state, never in the
  project tree.
- Same-key calls become local follow-ups on the caller's own session — no new
  session, no self-callback.
- Cross-agent cycles are rejected with the causal path in the message.
- Per-key FIFO order with exactly one active turn per session.
- Callbacks are durable (at-least-once, dedup via `callbackDeliveredAt`);
  closed/unreachable callers keep the item pending until a later flush.
- Calls active at process loss recover as `failed` with
  `interrupted-by-restart` — never silently replayed.

## Commands

```bash
npm install     # dev deps: typescript, vitest
npm test        # run the unit suite
npm run typecheck
npm run build   # emit dist/ (tsconfig.build.json)
```

## Layout

```
src/core/
  types.ts        # SessionRecord, CallRecord, TurnResult, profiles, receipts
  keys.ts         # canonical project id + v1 session keys
  jsonStore.ts    # atomic temp+rename JSON store with a serialized mutex
  registry.ts     # session key -> exact Pi session file (user-local)
  callStore.ts    # durable receipts + callback outbox
  profileStore.ts # dynamic agent profiles (names are data)
  mailbox.ts      # per-key FIFO, one active turn
  sessionHost.ts  # SessionHost interface (SDK host comes in Milestone 2)
  fakeHost.ts     # in-memory host for tests
  router.ts       # DelegationRouter: receipt, follow-up, cycle, outbox
test/
  keys.test.ts
  router.test.ts
```
