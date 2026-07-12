---
'@cat-factory/server': patch
---

Classify env-config-repair failures from the harness's STRUCTURED cause (error-message initiative
I3). `ContainerEnvConfigRepairer.pollRepair` ignored the already-plumbed `RunnerJobView.failureCause`
and classified a non-eviction failure purely by regex-matching the free-text error string. It now
prefers a new local `repairFailureKindFromCause(view.failureCause)` mapper (mirroring the execution
path's `agentFailureKindFromCause` and the bootstrapper's `bootstrapFailureKindFromCause`), with the
`classifyRepairFailure` error-string regex demoted to the fallback for an older harness image that
reports no cause. The completed-with-error path likewise routes through the mapper instead of a flat
`'agent'` default, so both failure sites classify identically to the bootstrap/execution paths. No
executor-harness image bump (the signal is minted by in-repo transports).
