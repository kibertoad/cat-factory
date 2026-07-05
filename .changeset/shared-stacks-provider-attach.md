---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
---

feat(environments): attach per-PR compose stacks to their shared stacks (shared-stacks slice 5)

Wire a stack recipe's `sharedStackRefs` + `externalNetworks` through to the per-PR consumer
environment, so a complex compose repo can reach the long-lived shared infra it depends on (the
acme `acme-net` shape). This is the provider-integration slice of the stack-recipes initiative.

- **Provider-before-consumer bring-up.** `SharedStackService.ensureRefsUp(workspaceId, refs)`
  brings each referenced shared stack up (via the idempotent `ensureUp`) IN ORDER and returns the
  deduped union of the Docker networks they own — or a blocking `error` (never a throw) for a
  missing ref, a failed bring-up, or a deployment with no host daemon. It is exposed to the compose
  provider as the new `ProvisionEnvironmentRequest.ensureSharedStacks` seam (a kernel
  `SharedStackEnsureResult`), bound in `EnvironmentProvisioningService.buildProvisionRequest`.
- **External-network attach.** `ComposeEnvironmentProvider.provisionRecipe` ensures the shared
  stacks up (streaming one `shared stacks (N)` provisioning-log step) and then attaches the per-PR
  project to `externalNetworks ∪ managedNetworks` via a new pure `attachExternalNetworks` folded
  into `prepareRecipeComposeFiles`: each network not already declared external across the merged
  `-f` layers is declared top-level `{ external: true }` and joined by every service (preserving
  the implicit `default` connectivity; skipping a `network_mode`-pinned service).
- Execution stays local-facade-bound (the documented compose runtime-binding exception); the recipe
  rides the existing persisted `provisioning` blob, so there is no migration. A recipe that
  references shared stacks on a deployment without the lifecycle wired fails loudly.
