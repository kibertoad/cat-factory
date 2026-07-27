---
'@cat-factory/integrations': patch
---

Surface the provider's failure reason on a poll-time environment failure. `EnvironmentProvisioningService.refreshStatus` built its status patch without `lastError`, so when a reconcile flipped an env to `failed` (a provider reporting the verdict on `provisioned.error` rather than throwing — e.g. a Kargo PREnv that fails to check out its branch), the reason was dropped: the env-detail surface and the environment self-test showed a generic "provisioning failed" / "status: failed" instead of the real cause. `refreshStatus` now persists `lastError` (from `provisioned.error`, cleared once not failed — mirroring the create path) and records the same reason on the failure-transition provisioning-log entry.
