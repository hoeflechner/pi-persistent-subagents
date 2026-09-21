# Open Questions

The concept is technically feasible. These decisions are missing or ambiguous
and materially change identity, routing, and lifecycle behavior.

## Decisions already made

- Target upstream Pi as an extension.
- Agent names are dynamic; `research`, `plan`, and `code` are examples only.
- Scope sessions per project, but keep all connection mappings in user-local
   extension state so another user of the same project gets independent state.
- Delegation is fire-and-forget: return a receipt now and inject the result as a
   later incoming message in the caller's chat.
- Code-capable agents use the shared working tree.

## Decisions still needed before implementation

1. **Persistence boundary**

   Must managed sessions survive a restart of the main Pi process and the
   machine, or only repeated calls during one running process?

2. **Project identity**

   Should a moved or separately cloned checkout count as the same project?
   Candidate identity inputs are canonical path, Git common directory, and
   remote URL. Path is unambiguous locally; remote URL joins clones that may not
   share working state.

3. **Task separation**

   Does “separated by task” mean the three role categories, or should two
   unrelated coding tasks in the same repository receive independent sets of
   managed agent sessions?

4. **Completion meaning**

   Is “session finishes” the end of one delegated turn while its history remains
   persistent? This document assumes yes.

5. **Callback activation**

   Should every callback automatically trigger a new model turn in the caller,
   or should it only append a visible message until a user or agent continues?
   The architecture currently assumes automatic activation.

6. **Offline caller**

   If the original root chat is closed, should the callback wait indefinitely
   for that exact session, expire after a retention period, or also appear in a
   global inbox visible from another chat?

7. **Busy-session policy**

   Is FIFO queueing sufficient? Should callers be able to inspect, reprioritize,
   or cancel queued calls?

8. **Cycle policy**

   Should repeated non-local agent keys in one callback chain always be rejected,
   and what maximum depth and delegation budget should apply?

9. **Agent permissions**

   Which defaults should new profiles receive for file edits, commands, network,
   and delegation? Per-profile allowlists remain configurable.

10. **Workspace isolation**

   Shared working tree is selected. Should every write-capable agent share one
   project-wide write lock, or is serializing each agent session sufficient?

11. **Worker lifetime**

    Should live sessions remain warm indefinitely, close after an idle timeout,
    or follow an LRU/memory limit? Closing need not remove persistent history.

12. **Configuration changes**

   When a profile prompt, model, or tool policy changes, should an existing
   session continue, fork, reset after confirmation, or be selected by version?

13. **Failure and replay**

   After a crash during a write-capable turn, should the call fail as
   interrupted or be
    retried automatically? Automatic retry can duplicate external effects.

14. **Retention and deletion**

   How long should managed transcripts and full result artifacts remain? Who
   can inspect, archive, reset, or delete them?

15. **Profile management**

   Where should user-local profiles be defined, and may a trusted project add
   or override profiles? The architecture recommends one dynamic `delegate`
   tool.

16. **Human visibility**

    Is a command-line status view enough, or is a live UI needed for transcripts,
    queues, usage, steering, and cancellation?

## Suggested defaults

For the first proof of concept:

- Upstream Pi extension.
- Survive process and machine restarts.
- One session per local user, project, and dynamic agent name.
- User-local registry and outbox; no connection files in the project.
- Fire-and-forget receipt with an automatic immediate-caller callback turn.
- FIFO queues with cancellation by call ID.
- Same-agent calls become follow-ups; reject other repeated session keys in
   causal ancestry; maximum depth 8.
- Conservative read-only defaults; explicit opt-in to edits and shell commands.
- Shared working tree with a project-wide write lock.
- Close live hosts after 30 minutes idle; preserve session files.
- Fail interrupted write-capable calls; do not replay automatically.
- One dynamic `delegate({ agent, prompt })` tool for the MVP.