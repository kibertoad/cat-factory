---
'@cat-factory/integrations': patch
---

Surface a Kubernetes environment that can't finish provisioning instead of leaving it spinning up forever.

Two gaps let a misconfigured ephemeral-environment (bad/insufficient ServiceAccount token, missing RBAC, or a rollout that never completes) sit at `provisioning` indefinitely with nothing shown in the run's "Infrastructure attempts":

- `KubernetesEnvironmentProvider`'s status read mapped **every** non-OK apiserver response — including `401`/`403` — to `provisioning`. A credential/permission error never self-heals, so the env never left "spinning up". It now throws a clear error on `401`/`403` (caught + logged by `refreshStatus`, after which the human-test gate degrades to manual mode) while transient `5xx`/`429` still keep polling.
- `EnvironmentProvisioningService.refreshStatus` only recorded a provisioning-log entry when the status read **threw**, so a reconciliation that flipped the env to `failed` without throwing (e.g. a rollout that exceeded its progress deadline, or a vanished namespace) left the "Infrastructure attempts" drawer empty. It now records a `failure` entry on the transition into `failed`.
