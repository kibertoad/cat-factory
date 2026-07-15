---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
---

Make `type: 'library'` frames behave correctly end-to-end (P0 of the library-frame-support
initiative). Previously picking `library` at import/bootstrap changed almost nothing: build
pipelines dispatched a deployer (a no-op at best) and an EXPLORATORY tester against a running
system that a published package doesn't have, and an infra-needing library's suite failed on a
missing DB because the harness's in-container compose stand-up was dormant.

Behaviour now ADAPTS to the frame, not to a copy of the pipeline catalog — via a single pure
capability profile shared by the engine + prompts:

- **`frameProfile(type)` (contracts)** — a table beside `visual-pipeline.ts` mapping a frame's
  block `type` to `{ deployable, liveTestable, hasUi, testPosture }`. `library` ⇒ not deployable,
  not live-testable, no UI, `suite` posture; `frontend`/`service` keep their deployable/exploratory
  defaults; any other type defaults to the service profile. The resolved frame `type` is carried on
  `AgentRunContext.service.type` so the deployer/tester paths and prompts can consult it.
- **Deployer no-ops on a library frame** regardless of its `provisioning` (a declared compose path
  on a library is repo-local TEST infra, not an environment): the runtime deploy loop records a
  library skip with an explanatory step output, and the run-start deployer-config /
  deployer-before-consumer / tester-infra gates pass through — so a library never demands a
  workspace environment handler.
- **Tester runs in suite posture on a library frame** (`TESTER_SYSTEM_PROMPT` +
  `testerEnvironmentSection`): run the unit + integration suite, assess public-API coverage against
  the change, and author the missing tests — instead of exploratory testing of a running system.
- **Local test infra revived for libraries** (`testerInfraSpec`): a library frame emits
  `{ environment: 'local', composePath }` when it declares a repo/package-local compose file — which
  brings the harness's dormant `standUpInfra` DinD path back to life on localhost — else
  `{ environment: 'local', noInfraDependencies }` and the tester self-manages test deps via the
  repo's `pretest:ci`/`test:ci`/`posttest:ci` lifecycle scripts. No harness image change (the
  `composePath` wire shape already exists).

Cross-runtime conformance asserts the whole thing: a deploy+test pipeline on a task under a real
`library` frame runs the deployer as a library no-op (provider never reached, no environment) and
the tester to completion — even when the frame declares a `docker-compose` path.
