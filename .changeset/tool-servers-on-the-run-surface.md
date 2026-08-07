---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Say which tool servers a step actually had, on the step

A run whose agent kind declares MCP tool servers could drop any of them for seven different
reasons, and until now every one of those was stated in two places nobody looks: the agent's own
system prompt, and one backend `warn` line. From the outside a run that quietly went without its
issue tracker was indistinguishable from a run whose agent simply chose not to use it, which is the
question an adopting deployment asks first and the platform could not answer.

**A dispatch now records what it decided on the step** (`PipelineStep.toolServers`): the servers it
wired (id, label, transport, and the narrowed `allowedTools` where the definition set one), the ones
it dropped each with its reason, and the agent kind those lists belong to. The step detail renders
them as chips, with translated copy per reason in every locale, and hides itself when the record
holds nothing (a kind that declares no tool servers, which is every step on a deployment that
registers none).

The kind is stamped by the engine as it folds, from the same parameter that feeds `step.dispatches`,
because a step's own kind is routinely not what ran: a `ci` gate escalates to `ci-fixer`, a tester
hands off to `fixer`, a two-phase coder dispatches twice. Each of those resolves its own
declarations and overwrites the record, so without the stamp the chips would credit one agent's
capabilities to another. The step detail names whose they are whenever the two differ.

**Recorded on the STEP rather than on the agent-context telemetry snapshot**, which is where the
same facts sat inside an untyped `extras` bag. The snapshot is double-gated behind
`LLM_RECORD_PROMPTS` and the per-workspace `storeAgentContext`, and pruned on the telemetry
retention window, so a surface reading it would be blank on any deployment that simply has prompt
recording off. "Which tools did this step have" is an ordinary question about a run, not an opt-in
debugging artifact. It also costs no telemetry migration: the run row already carries its steps as
JSON.

**Public API (additive, `info.version` 1.21.0):** each step of `GET /api/v1/debug/runs/:runId` now
carries the same record, so a diagnosing reader can tell "the agent never had the tool" from "the
agent had it and did not call it", which the tool-call trajectory alone cannot show. The snapshot's
`extras.toolServers` / `extras.unavailableToolServers` keep being served, deprecated, projected from
the step's own record so the two cannot disagree; the removal window is in `backend/docs/public-api.md`.

It is written at dispatch and never re-derived, for the same reason the model and the leased
subscription token are: the poll site rebuilds the job handle from the step alone, and whether a
server was servable depended on the resolved harness plus the facade's secret and OAuth resolvers at
that moment. A workspace that fills in a missing credential an hour later must not make a step that
ran without the tool read as one that had it. Absent and both-lists-empty stay different states:
absent is "no container dispatch recorded here", both-empty is "a dispatch ran and its kind declared
none".

**The unavailability vocabulary moved to `@cat-factory/contracts`, and kernel's
`UnavailableToolServer['reason']` is now typed against it.** The SPA cannot see kernel, so leaving
the union there would have made the run surface's copy a hand-written duplicate of a closed list,
and a member added on one side only renders as a blank chip. Which member a dispatch picks is still
decided in kernel. Internal break: the seven reason strings are unchanged, but the type now aliases
`ToolServerUnavailableReason`.

**Tool servers and capability credentials also gain their first cross-runtime assertions.** The
conformance harness could not reach either, because the suite runs a `FakeAgentExecutor` that
composes no job body, and the values are write-only on every wire. `ConformanceApp.toolServerDispatch()`
(built by `makeToolServerDispatchProbe` over each facade's OWN container) drives the same
`resolveToolServers` a dispatch does with the chain that facade actually composed, so a facade that
wired its per-workspace credential store behind the deployment environment (or not at all) now
fails a test instead of handing its agents an unauthenticated server. It asserts a stored credential
reaching the job body under its declared channel, an unstored one dropping the server as
`missing_secret` in the same resolution (the per-KEY composition rule), and a Pi run dropping
everything as `harness_unsupported`.

What this does NOT answer is a server that was wired and whose CLI failed to start it anyway: that
needs the agent CLI's own startup report, which is a harness change and therefore a runner-image
bump. It is the remaining half of the tracker's slice 5; the probe already diagnoses the same
condition interactively.
