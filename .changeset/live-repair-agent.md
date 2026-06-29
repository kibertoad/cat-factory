---
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

feat(environments): wire the live environment-provider config-repair agent (PR #416 increment 2)

When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
post-commit re-validation still fails) and the caller passed `allowAgentFallback`, the engine now
dispatches a coding agent that clones the target repo at the write branch, fixes the provider's
config file in place, and pushes the fix back onto the same branch — then `EnvironmentConnectionService`
re-validates.

- New `ContainerEnvConfigRepairer` (`@cat-factory/server`) dispatches a plain `coding` job via the
  shared `RunnerJobClient`/`RunnerTransport` (no `bootstrap` block, no PR) and awaits it. It is
  distinct from the repo-bootstrap flow — it never reinitialises history or force-pushes.
- The `dispatchConfigRepair` / `CoreDependencies.dispatchEnvConfigRepair` seam now returns `void`
  (it only pushes the fix); re-validation moved into `EnvironmentConnectionService`, where the
  decrypted secrets + manifest config live.
- Wired symmetrically across the Cloudflare and Node facades (local inherits via `buildNodeContainer`),
  gated on the container prerequisites plus an injected provider that supports `describeRepairAgent`,
  so a stock deployment running the generic manifest provider is unchanged.
