# pi-persistent-subagents

Give your Pi sessions **coworkers**. This extension adds a `delegate` tool
that hands tasks to persistent, named agent sessions — a research agent that
investigates the web for you, a review agent that audits anything you point it
at — while your own session stays free to keep working. Results arrive later,
right in the chat where you asked.

```
you: "research whether this smartband works without vendor cloud"
pi:  delegates → research bernhard (background session, keeps working)
…    you keep chatting; the agent searches, reads sources, saves findings
pi:  ← delegation_result: verified answer with sources + a findings file
```

## Install

```bash
pi install git:github.com/hoeflechner/pi-persistent-subagents
```

Then reload your session. That's it — two agents ship built-in, no config.

## Built-in agents

| agent | what it does |
|---|---|
| `research` | Multi-source web research. Never settles for partial answers, cross-checks load-bearing claims, cites every fact, keeps a durable notebook in `research/<topic>.md` in your project. |
| `review` | A fresh, unbiased second pair of eyes for **anything** — codebases, plans, itineraries, designs, documents. Reports what is missing, inconsistent, or risky (never a summary of what's there), read-only, ending with an honest `Not checked:` list. |

You normally never address them directly — just ask:

> *"review the `tools/` folder for missing docs and tests"*
> *"find out whether X is compatible with Y, check two sources"*

The main agent writes the delegation prompt, the subagent works in the
background, and the result lands back as a `delegation_result` message.

## How it behaves

- **Fire-and-forget.** `delegate` returns a receipt immediately; the turn runs
  in the background. Multiple calls to the same agent queue FIFO — it works
  through them one by one, remembering everything across all of them.
- **Persistent sessions.** One session per *(project, agent)*, created lazily
  and reused forever. The agent accumulates working memory across tasks in
  the same project; its sessions are ordinary Pi transcripts — visible by
  name (`research <project>`, `review <project>`) in session lists and
  `/resume`, and you can open one and talk to it directly.
- **It asks instead of guessing.** If only you can supply the missing piece,
  the agent calls `ask_caller` — the question reaches the delegating session,
  an answer can be routed back, and the agent continues with full context.
- **Durable delivery.** Callbacks survive restarts: a result whose recipient
  was not attached is kept pending and redelivered when that session starts
  again. Calls interrupted by a process loss are reported as failed — never
  silently replayed.

## Commands

```
/subagents                    # overview: profiles + sessions + call states
/subagents doctor             # consistency check of state vs. disk
/subagents reset <agent>      # close an agent's session and delete its transcript
/subagents model <agent> …    # pin a model for an agent (or back to caller's)
```

## Defining your own agents

Drop a YAML file into **`~/.pi/agents/`** — it becomes available on the very
next delegation:

```yaml
# ~/.pi/agents/summarizer.yaml
profiles:
  summarizer:
    description: condenses long reports into executive summaries
    tools: ["*"]          # capabilities; ["*"] = full tool access
    # model: auto         # "auto" = mirror the delegating session's model
    bootstrap: |
      # Summarizer
      You take long documents and produce tight executive summaries.
      Deliver the complete summary via yield_to_caller.
```

Precedence: `~/.pi/agent/subagents/profiles.yaml` > `~/.pi/agents/*.yaml` >
built-ins. **A project directory is never a profile source** — cloning a
repository cannot rewrite your agents.

## Configuration

| variable | default | meaning |
|---|---|---|
| `PI_SUBAGENTS_STATE_DIR` | `~/.pi/agent/subagents` | registry, call outbox, user profiles |
| `PI_SUBAGENTS_AGENTS_DIR` | `~/.pi/agents` | drop-in profile files |
| `PI_SUBAGENTS_SESSION_DIR` | Pi's default session dir | where agent transcripts live (keep the default to see them in session lists) |

## Notes & troubleshooting

- **`queued`/`running` means busy, not stuck.** One turn per agent session at
  a time; check `/subagents` or open the agent's session to watch it work.
- In an agent's transcript you may occasionally see a note that
  `yield_to_caller` has no caller right now — that's the protocol guard doing
  its job when a background session is driven interactively; the agent simply
  answers as plain text.
- Delegated work happens in **your project directory** with your tools —
  agents can write files there. The `review` agent is instructed to stay
  read-only.
- If an agent persona drifts or its memory gets noisy: `/subagents reset
  <agent>` and it starts fresh.

## For developers

```bash
npm install && npm run build && npm test
```

Design and invariants: [`doc/architecture.md`](doc/architecture.md).
`dist/` is committed (Pi loads it directly) — **always `npm run build` before
committing `src/`**.
