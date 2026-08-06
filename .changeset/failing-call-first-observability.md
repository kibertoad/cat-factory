---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Failing-call-first debugging: pin what broke, and let both drill-downs narrow to it

The observability panel already held everything needed to diagnose a run, and asked an operator to
find it by scrolling. Worse, one whole failure class had nowhere to be found from: a tool that
errors executes INSIDE the container, so the model call that requested it still records `ok` with a
clean finish reason. Every LLM number on the panel, and every rollup on the debug overview, reads
healthy right up to the moment the run dies. The remote-debugging doc named this as a known
limitation ("tool-execution errors are rows, but no rollup counts them"); this closes it on both
surfaces.

**The panel opens with the failure.** A pinned section above the lists carries the run's structured
`failure` record (kind, message, hint, the step it died on) beside the last model call that failed
and the last tool call that failed, each with a count of the earlier ones and a jump into the list.
It appears whenever there is something to pin rather than only on `status === 'failed'`: a run still
in flight whose calls are already erroring is exactly the one worth interrupting.

The two evidence rows are shown in a fixed order and are deliberately NOT ranked against each other.
They come from different clocks (a call's recorded `createdAt`, a tool span's harness-stamped
`startedAt`), so "which happened last" is not a comparison this can make honestly, and a confident
wrong ordering is worse than none in a section whose whole job is to be believed.

**When nothing failing can be pinned, it says which of four things that means.** A sink's read
FAILED (nothing can be concluded, and this outranks the rest); both sinks answered and nothing
failed (the cause left no row: look at the engine); neither sink recorded anything (the run died
before any agent work); or one answered with rows and the other did not. A single "no failures
found" would render a clean bill of health over a run that died with no telemetry at all, which is
the same false picture in the opposite direction. A read still in flight is none of the four: the
section withholds every verdict until both sinks have answered.

**Both drill-downs narrow by outcome.** The model-call list gets `All / Failed / Cut short / OK`
with live counts, split that way because a failed call and a truncated one need different fixes
(transport, proxy or spend-gate trouble versus an output-limit conversation). The tool-call
trajectory is a new panel view with `All / Failed / OK`, keeping trajectory order under every
filter: reading the failures in sequence is what tells one tool that failed and was worked around
from an edit loop stuck repeating the same failing call.

On the public API (OpenAPI `1.14.0`): `GET /api/v1/debug/runs/:runId/tool-calls` takes
`?outcome=ok|error`, composing with both orders and with `?jobId=`.
`failure_outside_model_calls` now states what the trajectory actually holds instead of pointing at
it unconditionally.

**That parameter REPLACES the `?ok=true|false` filter published in `1.13.0`, which is a breaking
change taken deliberately as a minor.** `?ok=` shipped one release ago, has no known consumer, and
two drill-downs answering the same question under two spellings is the wart this change exists to
remove: an operator who learned `?outcome=` on the model-call list should not have to discover that
the tool-call list spells it differently. A picklist also lets the set gain a member (a timeout, a
refusal) where `true|false` could only be retyped. Had there been an adopter, the honest shape would
have been `?ok=` served beside `?outcome=` for a release window, not a rename.

The run's failure count stays on the `toolCalls` rollup (`totals.failures`) rather than being copied
onto `sinks.toolCalls`: both come out of ONE `(agentKind, tool)` aggregate pass, and a second copy
could only be a second read of the same rows, which is how a `failed` above its own `count` gets
published.

The narrowing is applied IN SQL on all three stores, which is the part that makes it correct rather
than convenient: the trajectory read is bounded to a PREFIX of the run, so a filter applied after
the read would report no failures on any run whose failures came after its opening moves. Internal
break: the trajectory/page queries gain an `ok?: boolean` field, and the panel's per-run counts are
folded from `AgentToolCallRepository.summarizeByExecution` rather than counted by a query of their
own.

**The panel obeys the same prefix rule the stores do.** It reads the sink through two
workspace-scoped routes rather than one. `tool-call-failures` is the headline, made on open: the
run's exact `{ total, failed }` from the store's aggregate pass, plus the failing rows narrowed in
SQL. `tool-calls` is the browse view, loaded only when the trajectory is opened, because it carries
every captured argument and result the run produced. Folding them into one read would either make
the headline wait on megabytes or make its counts a statement about the run's opening moves wearing
the run's name, and the second is the same false all-clear from the other direction. The trajectory
now reports `truncated`, and a bounded view says so on screen instead of presenting a prefix as
everything the run did.

**One classification, in one place.** `LLM_WARNING_FINISH_REASONS`, the `ok | warning | error`
vocabulary and the rule that produces it now live once in `@cat-factory/contracts`. Four copies
existed: kernel's `LlmCallOutcomeFilter`, orchestration's `classifyCall`, the debug wire's
`debugCallOutcomeSchema`, and a hand-written list in the SPA. All four now alias or re-export the
one definition, so a member added to the vocabulary cannot exist in the badge and not in the filter.
Internal break: `classifyCall`/`isWarningFinishReason` are exported from `@cat-factory/orchestration`
as `classifyLlmCallOutcome`/`isLlmWarningFinishReason`.
