# Environment disposal: the `disposer` step and positive teardown proof

> Supersedes the root-level `PLAN-deployer-disposer-and-environment-lifecycle.md` proposal, whose
> workstreams A, B and E have since landed. What remained was workstream C (the `disposer` kind)
> and the correctness problem the plan did not name: a teardown the platform could not verify.

## Goal & rationale

A run's PR carries a **test environment lifecycle** section asserting a three-leg proof: the
environment came **UP**, evidence was **CAPTURED** against it while it was live, and it was torn
**DOWN** again ([`pr-verification-report.md`](./pr-verification-report.md)). Two things were wrong
with the third leg.

**1. Nothing closed it inside the run.** Teardown happened only on a TTL sweep (a 2-minute cron
against `expires_at`), an operator's manual Destroy, a `human-test` gate resolution, or a
re-provision supersede. The sweep fires long after the last step settled, so the PR was published
saying the environment was still live and corrected minutes-to-hours later, via the
`EnvironmentTeardownRecordedHook` back-channel, and only on a deployment that retains a
provisioning log. TTL is a fine BACKSTOP and cannot be a PROOF.

**2. The teardown that did happen was never verified.** `teardownRecord` logged
`outcome: 'success'` whenever `provider.teardown()` returned without throwing. That is not the
same fact as the environment being gone:

- `HttpEnvironmentProvider.teardown` returns `{ status: 'torn_down' }` unconditionally. A manifest
  that declares no `teardown:` request calls **nothing** and reports success.
- A Kubernetes namespace `DELETE` is accepted immediately while the namespace sits in
  `Terminating` until its finalizers drain.

So the section could render **"✅ torn down"** about an environment that was still running and
still billing, which is worse than the honest "still live" it was meant to replace: it is a green
tick on a claim nobody checked.

**Intended end state:** an author can place a `disposer` step wherever the environment should go
away, and every teardown path — disposer, TTL sweep, manual Destroy, supersede — records what an
INDEPENDENT probe found afterwards, so only a positively confirmed reclaim reads as one.

## Target pattern

- **The confirmation seam** is the optional kernel `EnvironmentProvider.confirmTeardown`
  (`ports/environment-provider.ts`), returning a `TeardownProbe`
  (`gone` / `present` + `terminating` / `unknown` + `retryable`). Deliberately NOT folded into
  `status()`: every `status()` implementation is written to describe a LIVE environment, so its
  answers about a destroyed one are incidental — `HttpEnvironmentProvider` with no `status:`
  template returns `ready` forever, and `classifyComposePs` maps an empty project to `failed`,
  which is right for a live environment and exactly inverted for a reclaimed one. A separate
  method lets a provider that cannot answer say so instead of having an answer inferred from a
  call meant for something else.
- **One classifier, one recording site.** `classifyTeardownProbe` (pure, in `environments.logic.ts`)
  maps the probe onto the `TeardownConfirmation` vocabulary, and
  `EnvironmentTeardownService.teardownRecord` is the ONE place that records it — the same
  single-site rule the teardown-recorded hook already follows, so a future fourth teardown path
  cannot forget to verify.
- **A second log row, not a richer one.** The confirmation lands as its own
  `operation: 'teardown-verify'` row, because it records a different observer than the `teardown`
  row beside it. A consumer reading only the outcome column still cannot mistake an unverified
  teardown for a reclaim.
- **The disposer** mirrors `DeployerStepController`: an operational (non-LLM) StepHandler
  registered at `order: 105`, fanning out per service frame with each frame's outcome persisted
  before the next is attempted (replay resumes at the first un-settled frame).

## Conventions & gotchas carried between iterations

- **The disposer reads the deployer's recorded `deployEnvs`; it does NOT re-resolve anything.**
  That set is the exact list of environments this run stood up, so a mid-run connection edit
  cannot widen the disposer onto a peer it never deployed nor narrow it off one it did.
- **The ENVIRONMENT ID is recorded too, and re-resolving it is a bug, not just redundancy.**
  `deployEnvs[frame].environmentId` is written at the moment the deployer resolves the handle,
  and the disposer tears down by it. Resolving the environment from `(block, frame)` instead
  looks correct and is not: `readRegistryRecord` falls back to the block's FRAME-LESS row when the
  frame's own row is gone, and frame-less rows are the manual / `human-test` environments. A
  disposer running after a supersede, an operator's Destroy, or a TTL sweep on a long run would
  therefore resolve and destroy an environment this run never provisioned, and book it as this
  frame's clean reclaim. A `ready` frame with no recorded id (a run in flight when the field
  landed) is reported as un-reclaimed with the reason named, never guessed at and never `none`.
- **A registry outage must not read as an environment that is already gone.** Both arrive at the
  same call site and only the error TYPE separates them: a `NotFoundError` is "something else
  already reclaimed it" (`none`), anything else is a failure to reclaim (`failed`). The earlier
  `.catch(() => null)` collapsed them and reported "nothing to reclaim" about a live environment.
- **The disposer NEVER fails the run.** It commonly sits after `merger`: the work shipped and the
  PR is in, so an un-reclaimed environment is a recorded warning and an operator's job. This is
  the opposite disposition from the deployer, whose primary-frame failure IS terminal —
  provisioning is a prerequisite, disposal is cleanup.
- **`unverifiable` vs `unconfirmed` is load-bearing.** A manifest with no `status:` request
  answers identically forever and is only fixed by a human editing it; an apiserver that refused
  one read may answer the next. Collapsing them leaves an operator waiting for a confirmation
  that is never coming. That is what `TeardownProbe`'s `retryable` flag carries.
- **`still_standing` is not a failure of the platform**, and must not be recorded as one: the
  teardown call succeeded. It is a failure of the PROVIDER CONFIG, and the fix is a manifest edit
  plus a manual reclaim, so it is its own verdict rather than a shade of "failed".
- **Absence of a verify row is not a pass.** A run whose teardown predates this change, or whose
  verify write was lost, has a teardown row and no verify row; the report reads that as
  `unconfirmed`. Deliberate — silence about an environment is exactly what stopped being read as
  its death.
- **The teardown-recorded hook must fire after EVERY row for that teardown, confirmation
  included.** Its one consumer re-reads the log to recompose the report, so a hook fired between
  the two writes sees a teardown nothing has verified and publishes `unconfirmed` about an
  environment the very next write proves gone. It is the last edge on an already-settled run, so
  nothing corrects it: firing early made `confirmed` unreachable in production while every unit
  test still passed. Both writes and the notification therefore live in ONE method that takes the
  confirmation, rather than in a sequence a caller can get wrong. The regression test asserts the
  ROW COUNT AT CALL TIME, because no assertion on the final rows can see the order.
- **`confirmTeardown` is bounded in wall-clock time by the service, not by trust in the
  provider.** It is a public port awaited inline on the on-demand teardown (holding an HTTP
  request open) and on the TTL sweep (where one wedged environment would block the rest of the
  pass). A timeout is `unconfirmed`, not `unverifiable`: it may answer next sweep.
- **`TeardownProbe` crosses a public port, so its `switch` needs a `never` default.** A provider
  returning an unrecognised `state` would otherwise fall off the end and make the verdict
  `undefined` — neither a reclaim nor an honest refusal to say, and written straight into the log
  row. The `describeUnrecognisedProbe(never)` helper keeps the compile-time guard while making the
  runtime answer honest, the same shape as kernel's `describeModality`.
- **`describeError` returns `LogFields`, not a string.** It is for log fields; a confirmation
  reason is rendered to a human on a PR, so it uses `getErrorMessage` (a `describeError` there
  lands as `[object Object]` — caught by a test, not the typechecker).
- The `sweepExpired` count includes environments it could not confirm. The record is tombstoned
  either way, so counting only confirmed ones would report the same environment as un-swept
  forever while the sweep never touches it again.

## Status checklist

### Slice A: positive teardown confirmation (every teardown path)

| Unit                                                                                         | Status | PR   |
| -------------------------------------------------------------------------------------------- | ------ | ---- |
| Kernel port: `TeardownProbe` + optional `EnvironmentProvider.confirmTeardown`                | done   | this |
| Contracts: `teardownConfirmationSchema` (4 members) + `teardown-verify` log operation        | done   | this |
| `classifyTeardownProbe` (pure) + `EnvironmentTeardownService` probe, recorded as its own row | done   | this |
| `KubernetesEnvironmentProvider.confirmTeardown` (namespace read; `Terminating` split)        | done   | this |
| `HttpEnvironmentProvider.confirmTeardown` (no `teardown:` ⇒ present; no `status:` ⇒ unknown) | done   | this |
| `ComposeEnvironmentProvider.confirmTeardown` (`countComposePs`, not the status mapping)      | done   | this |
| `CloudflareEnvironmentProvider.confirmTeardown` (states that it has nothing to observe)      | done   | this |
| Unit tests: each confirmation state, the throwing probe, no verify row on a failed teardown  | done   | this |

### Slice B: the `disposer` step

| Unit                                                                                                                   | Status | PR    |
| ---------------------------------------------------------------------------------------------------------------------- | ------ | ----- |
| `DISPOSER_AGENT_KIND` + `isDisposeStep` (`environments.logic.ts`), exported from the index                             | done   | this  |
| Contracts: `disposeEnvStateSchema` / `disposeEnvsSchema` + `PipelineStep.disposeEnvs`                                  | done   | this  |
| `DisposerStepController` (frame fan-out, per-frame persist, best-effort)                                               | done   | this  |
| `deployEnvs[frame].environmentId` recorded at deploy; disposer reclaims BY ID, never re-resolves                       | done   | this  |
| StepHandler registered at `order: 105`; `environmentTeardown` threaded into `RunDispatcher`                            | done   | this  |
| `step-surface.test.ts`: `disposer` is not an inline model step                                                         | done   | this  |
| Frontend: palette archetype (`category: 'test'`) so it is user-placeable                                               | done   | this  |
| Unit tests: run-scoped frames, confirmed/unconfirmed/failed, replay resume, unwired                                    | done   | this  |
| Unit tests: reclaim by recorded id, latest id wins on re-deploy, missing id refuses to guess, `NotFoundError` ≠ outage | done   | this  |
| Conformance: deploy→dispose reclaims the run's own env and confirms it; unverifiable never fails the run               | done   | this  |
| Every deploying built-in preset ends with a terminal `disposer` (plan D-C5, settled by the save-time rule)             | done   | later |

### Slice C: the report's third leg

| Unit                                                                                   | Status | PR   |
| -------------------------------------------------------------------------------------- | ------ | ---- |
| `teardown: 'unconfirmed'` + `timeline.teardownsUnconfirmed`                            | done   | this |
| `indexEnvironments` follows verify rows by identity; absence of one is not a pass      | done   | this |
| Gaps carry the probe's VERBATIM reason (deduped); render is ⚠️, neither tick nor cross | done   | this |
| Unit tests: unverified ≠ reclaimed, unconfirmed ≠ pending, mixed run reports `pending` | done   | this |

### Deferred (NOT in this PR — each needs its own call)

| Unit                                                                                                                                                                                                                                                                                                            | Status   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `DELETE /environments/:id` still answers `status: 'torn_down'` unconditionally. The confirmation is recorded in the log the drawer reads, but the endpoint's own response does not carry it; adding it means widening `EnvironmentHandle`.                                                                      | deferred |
| Container-backed (`asyncTeardown`) disposal, for a helm/kustomize uninstall that needs a deploy container. Namespace-DELETE covers the k8s adapter today; the plan's original deferral stands.                                                                                                                  | deferred |
| `ENVIRONMENT_DEFAULT_TTL_MINUTES` (plan D1), so no environment is immortal when neither provider nor manifest supplies a TTL. Independent of this work and still worth doing: a pipeline STORED before the save-time rule can still carry a deployer and no disposer, so TTL remains the only backstop for one. | deferred |
| A sweep lease (plan D3), so a concurrent Node timer + CF cron cannot double-invoke a teardown. Providers are idempotent, so this stays low priority.                                                                                                                                                            | deferred |
