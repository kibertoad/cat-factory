---
'@cat-factory/orchestration': patch
---

Extract the requirements-review and clarity-review gate handlers out of
`ExecutionService` into a shared `ReviewGateController`. The two gates ran the SAME
control flow (inline reviewer pass → park the run on a durable decision → fold the
human's answers → re-review until convergence / iteration cap → advance), duplicated
method-for-method across the engine. The flow now lives in one kind-parameterised
collaborator; each subject supplies only its differentiators through a `ReviewKind`
(the review service, the live event, the `agentKind`, and — for clarity — threading the
upstream `bug-investigator` output into the reviewer context). The shared state-machine
primitives reused by the generic approval path and the companion iteration-cap gate
(`parkStepOnDecision`, `advancePastResolvedGate`, `dispatchIterationCap`) stay on the
engine and are injected. Pure refactor: the public method signatures the HTTP
controllers call (`reviewRequirements`/`incorporateRequirements`/`reReviewRequirements`/
`proceedRequirements`/`resolveRequirementsExceeded` and the clarity equivalents), the
wire contracts, the persisted tables and the durable parked-run/resume behaviour are
unchanged.
