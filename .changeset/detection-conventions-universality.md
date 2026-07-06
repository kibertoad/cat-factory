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
follow different conventions than the stack-recipes pilot (different names, paths, tech stack). The
changes are additive in the sense that detection can only ever surface MORE — it never removes or
changes an existing detection, and a repo with no monorepo service-container dirs resolves exactly
as before. Note the one behavioural change below: the env-template scan now also looks one level into
`services/*`/`apps/*`/`packages/*`, so a monorepo that keeps per-service templates there will now
surface them as low-confidence, user-confirmed `recipe.envFiles` where it previously surfaced none.

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
  This is on by default (not gated behind conventions), so any monorepo with a compose file AND
  per-service templates newly gets those as `recipe.envFiles`; they are low-confidence and confirmed
  in the wizard before anything is materialized.
- **The environment setup wizard elevates the "run deep analysis" nudge** when a repo ships its own
  imperative bring-up CLI/Makefile the deterministic scan can't read (`@cat-factory/app`), pointing the
  user at the LLM analyst — the intended universality mechanism for stack-specific imperative steps.
