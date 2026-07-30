---
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/node-server': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
---

Split the six files over 2,000 lines along cohesive seams so the oxlint `max-lines` ceiling can
drop to its floor: the engine's human decision surface into `StepDecisionController`, the
dispatcher's running-poll branch tree and one-shot engine steps into `PollRunningController` /
`OneShotStepController`, the Worker composition root into model-resolver / executor-deps /
vcs-identity modules, provisioning auto-detection's Kubernetes half into its own module, and the
Node schema's tenancy tables into `db/tables/identity.ts`. Every extraction is a behaviour-neutral
move behind unchanged public surfaces.
