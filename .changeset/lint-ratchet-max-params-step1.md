---
'@cat-factory/node-server': patch
---

Lint ratchet: `max-params` step 1 (20 → 10; no behavioural change).

Convert the lone 20-argument offender — the Node facade's `buildNodeContainerExecutor` —
from positional parameters to a single `NodeContainerExecutorDeps` options object, and update
its one call site in `runtimes/node`'s `container.ts` to pass named fields. Lower `max-params`
to `10` in `.oxlintrc.json`. The new floor is `10` (`DeployerStepController`), the next step's
first split.
