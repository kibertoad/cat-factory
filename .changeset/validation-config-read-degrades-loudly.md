---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Say when the validation configuration could not be READ, and keep telemetry long enough to read

Two independent honesty gaps in what a run reports about itself.

**A failed validation-config read rendered as an unconfigured service.** A dispatch resolves the
service frame's pre-PR validation checks, and `AgentContextBuilder.validationChecksFor` catches a
throw and degrades to "no checks" so a config-store outage (or a mothership node whose server does
not reflect `validationConfigRepository`) cannot wedge every coding run. That trade is right and
stays. What was wrong is that it was the whole story: the catch was bare, so a service whose checks
had silently stopped running produced the exact context of a service that never had any, and the PR
verification report then stated in the reviewer's face that "this service configures no check
commands", a fabricated fact about somebody's setup, in the one section built to stop an agent
asserting things it did not verify.

The read now degrades loudly. The catch warns with the frame id and the scrubbed cause, and sets
`step.validationConfigUnreadable`, which the report reads as `PrReportValidation.configUnreadable`.
On an absent section that DISPLACES the unconfigured note rather than qualifying it (a skimming
reader must not come away with the wrong one of two opposite readings); on a reported section it is
a callout above the verdict, because a later dispatch whose read failed ran unvalidated after the
evidence was captured and an unqualified green table would overstate what it covers. The flag is
rewritten on every dispatch of the step, so a transient outage that recovered before the PR-opening
dispatch leaves no warning behind, and the report scans every step for it, because the failing read
is by construction on a step that produced no validation evidence to hang it off.

`configUnreadable` is an additive optional field on the run report, which is part of the stable
`/api/v1` surface: OpenAPI `info.version` goes to 1.12.0 and the four SDKs plus the MCP facade are
regenerated. A consumer built against 1.11.0 keeps parsing.

**`LLM_CALL_METRICS_RETENTION_DAYS` now defaults to 14 days rather than 3.** The store exists for
post-mortems and an investigation into a failed run routinely starts days after it, so the old
window expired the record before anyone looked: a run that failed on a Friday was unreadable by
Monday. Fourteen matches the provisioning log's default and keeps a working week plus its
weekend. The heavy half of the store is the recorded bodies, which are already double-gated behind
`LLM_RECORD_PROMPTS` and the per-workspace `storeAgentContext`, so a deployment that records them
and wants the old footprint sets the variable back to 3.
