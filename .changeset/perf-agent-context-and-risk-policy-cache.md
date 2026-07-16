---
'@cat-factory/orchestration': patch
'@cat-factory/kernel': patch
'@cat-factory/caching': patch
---

perf(engine): resolve the agent-context service frame once, and cache the merge-preset read

- `AgentContextBuilder` walks a block's ancestry to its owning service frame a SINGLE time
  per dispatch (threaded into the environment / service-config / frontend / fragment
  resolvers) and fans the mutually-independent context resolutions out in one `Promise.all`
  wave, instead of re-walking frame→module→task once per resolver and awaiting each in turn
  (performance initiative item 13).
- `resolveRiskPolicy` reads a task's merge-threshold preset through a new `riskPolicy`
  AppCaches slice — the slow-moving admin config was re-read on every gate evaluation.
  `RiskPolicyService` invalidates the workspace group on every preset write (create / update /
  remove / reseed / first-use seed); pass-through on the Worker's isolate-safe profile
  (performance initiative item 23).
