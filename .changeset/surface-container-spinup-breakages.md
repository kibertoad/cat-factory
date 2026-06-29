---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Surface container/environment spin-up breakages on the agent step instead of hanging or hiding them.

- **Local Docker mode fails fast.** `LocalContainerRunnerTransport` now aborts the
  container start the moment the container has exited (or a CLI call fails) instead of
  spinning for the full ready timeout, and the thrown error carries the real Docker
  stderr plus a tail of the container's own logs — so a broken daemon / failed image
  pull / crashing entrypoint shows the root cause in the step's failure card and the
  provisioning-logs drawer within one poll rather than ~60s of "spinning up container".
  Adds a `logs()` method to the `ContainerRuntimeAdapter` seam (Docker + Apple adapters).

- **Kubernetes runner fails fast on doomed pods.** `KubernetesRunnerTransport` now
  detects terminal container start-up reasons (`ImagePullBackOff`/`ErrImagePull`/
  `InvalidImageName`/`CreateContainerConfigError`/`CrashLoopBackOff`/…) and aborts the
  readiness wait immediately with the pod's real `reason: message` as a hard `dispatch`
  failure — instead of polling the full 120s and then mis-tagging a deterministic failure
  (e.g. a bad image) as a recoverable "evicted" that the engine re-drives into the same
  120s hang. The recoverable timeout/terminated paths are also enriched with the latest
  pod-status detail so a stuck pod is no longer a bare "not ready within 120000ms".

- **Custom EnvironmentProvider failures are stored and displayed.** A failed `deployer`
  provision (the provider threw, or returned `status:'failed'`) is now a real, displayed
  step failure: the errored environment (with the provider's verbatim `lastError`) is
  persisted and stamped onto the step, and the run records a new `environment`
  `AgentFailureKind` — instead of a green step with the error buried in its prose output.
  A provider that reports `status:'failed'` WITHOUT throwing can now carry its verbatim
  reason on the new optional `ProvisionedEnvironment.error` field (`@cat-factory/kernel`),
  which surfaces as the step's `lastError` instead of a generic "Provisioning failed". The
  failure is terminal + surfaced for one-click retry (NOT auto-retried), deliberately
  symmetric with the `dispatch` (container-failed-to-start) failure.

**Breaking shape change:** `agentFailureKindSchema` gains the `environment` member.
Pre-1.0, no migration — stale failure rows simply don't use the new kind.
