---
'@cat-factory/contracts': minor
---

feat(environments): stack-recipe contracts (shared-stacks initiative, slice 1)

Add the declarative `StackRecipe` shape to the `docker-compose` branch of `ServiceProvisioning`
plus the recommendation-shape extensions the detector (slice 2) will populate — the contracts
foundation for provisioning complex multi-step compose repos (the lokalise-main pilot).

- New optional `recipe` field on `serviceProvisioningSchema` (`stackRecipeSchema`): ordered
  `-f` `composeFiles` layering, `composeProfiles`, `envFiles` materialization (template →
  gitignored target), `externalNetworks`, `sharedStackRefs`, ordered `setupSteps`/`teardownSteps`
  (`recipeStepSchema` — `compose-exec` / `copy-file` / `wait-http` / `wait-file` / `host-command`,
  each with a per-step timeout budget), and a terminal `healthGate` (`compose-healthy` default /
  `http` / `compose-exec`). Every field is optional, so the existing single-file `composePath`
  config parses unchanged.
- New recommendation candidate arrays + hint on `provisioningRecommendationSchema`:
  `composeFileCandidates`, `profileCandidates`, `seedDumpCandidates`, and the report-only
  `repoCliHint`; the detection-note `field` vocabulary is extended for the new recipe fields.

Contracts-only; additive and non-breaking. The compose provider will consume the persisted
recipe in slice 3; detection populates the recommendation in slice 2.
