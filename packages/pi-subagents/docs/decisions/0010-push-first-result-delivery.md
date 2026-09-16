---
status: accepted
---

# 0010 — Push results through Pi, pull details on demand

## Context

Completion notices previously carried a 500-character preview and required `get_subagent_result` to collect every outcome.
Notifications were withheld until the entire parent run settled, and the model-facing resume always waited.
This encouraged polling and delayed questions even while the parent had independent work.

## Decision

Use the existing native Pi message queues, not another scheduler or conversation journal.
Push up to 12,000 characters of result text, explicitly identify truncation, and include the canonical child JSONL path when available.
Keep the renderer preview at 500 characters.
The retained record supplies the full final answer through `get_subagent_result`; `verbose` includes the live conversation when available, and file reads provide the durable transcript after session release.

Hold notifications until the parent's `turn_end`, then recheck pull claims, consumption and run identity before steering them into Pi's next model step.
This boundary is after tool results, so a pull in the same step wins without an extra completion message.
Keep `agent_settled` as the fallback for failure, interruption and completions arriving after the last step.
Idle delivery uses a follow-up with `triggerTurn: true`.
Child completion is offered only after native execution settles, so a question's resume affordance reflects an actionable session rather than an execution flag that is about to clear.
An agent stopped before starting can report that fact immediately without waiting for a concurrency slot.

A handoff suppresses duplicate pushes but does not count as consumption.
Only the live custom-message `message_end` acknowledges that Pi delivered the report into the parent's conversation.
Weakly keyed message details correlate this acknowledgement without adding durable delivery state.
An internal monotonically increasing run version invalidates stale queued notices and acknowledgements across resume, including runs with identical timestamps.
Consumption is transport delivery, not proof the model read or acted on the result.
Unanswered questions continue to use the longer retention window.

Allow background resume through the existing synchronous `startResume` admission API.
Omitted or false `run_in_background` retains awaited resume behavior; the delivery choice does not reconfigure the retained child.
Guidance tells parents to work independently or end the current turn, not to poll or declare the overall task complete while children still own work.

## Consequences

The pull-first notification decision in the historical consumption-aware retention plan is superseded.
Full results and transcripts remain accessible without an obligatory retrieval round trip.
No notification delivery is reconstructed after restart, and Pi remains the sole queue and transcript authority.
An interrupted or discarded queued message is not consumption; its result remains available to explicit retrieval under the unconsumed retention policy.
Once handed to Pi, a notification cannot be recalled if an external actor retrieves or resumes the child before Pi delivers it.
The run-version check prevents that old delivery from consuming the successor's result.
