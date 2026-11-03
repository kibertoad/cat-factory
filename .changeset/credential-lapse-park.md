---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A run whose personal subscription credential lapses now parks instead of failing.

- When a step's dispatch cannot lease the run's personal-subscription activation (it expired, typically because a requirements review or another park ran past its 12h lifetime), the step parks on a credential wait (`PipelineStep.credentialWait`) and the run goes `blocked`. The run panel and the step detail show a notice whose button rides the cached personal password, or prompts for it, re-mints the activation through `POST /executions/:executionId/credential/resume`, and re-dispatches the same step.
- The engine recognises the refused lease in one place, around every call that can dispatch a step, so it covers every path that advances a run. The approve, request-changes, resolve-decision and resolve-exceeded routes no longer re-mint the activation themselves, and the SPA no longer sends the personal password on those calls.
- Public API: `credential_lapsed` joins the unanswerable-wait reasons a run's decision list reports (OpenAPI 1.93.0, SDKs regenerated). `credential_wait_not_parked` joins the conflict reasons.
