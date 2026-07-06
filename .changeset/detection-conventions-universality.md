---
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
---

Make ephemeral-environment provisioning DETECTION more universal — so it adapts to repos that
follow different conventions than the stack-recipes pilot (different names, paths, tech stack). All
changes are additive: a default-shaped repo detects exactly as before.

- **Injectable detection conventions (deployment config).** A deployment can extend the built-in
  compose file names/dirs, seed dirs, and env-template dirs via the `ENVIRONMENTS_DETECTION_CONVENTIONS`
  JSON env var, threaded additively (built-ins always win; canonical compose names stay
  highest-priority) through `CoreDependencies.detectionConventions` into BOTH the service-provisioning
  detector (`EnvironmentConnectionService`) and the shared-stack detector (`SharedStackService`). New
  `parseDetectionConventions` + `EnvironmentsConfig.detectionConventions` (`@cat-factory/server`,
  parsed by both facades) and the exported `DetectionConventions` type (`@cat-factory/integrations`).
- **Env-template detection now scans one level into monorepo service-container dirs** (`services/*`,
  `apps/*`, `packages/*`), so a per-service `*-dist`/`.example` template outside the compose dir (the
  pilot's documented `services/app/` gap) is surfaced — still bounded by the existing read budget.
- **The environment setup wizard elevates the "run deep analysis" nudge** when a repo ships its own
  imperative bring-up CLI/Makefile the deterministic scan can't read (`@cat-factory/app`), pointing the
  user at the LLM analyst — the intended universality mechanism for stack-specific imperative steps.
