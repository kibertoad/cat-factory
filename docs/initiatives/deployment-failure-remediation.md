# Deployment failure remediation

Goal: when a `deployer` step fails for a cause an agent could actually fix in the checkout, fix it
automatically and re-provision, bounded; and when it fails for any other cause, say so precisely
instead of sending anybody (human or agent) to the wrong file.

## Why now

A real `pl_build` run (`exec_194b231198454c7785f29589`, PR `kibertoad/cf-acc-catalog-api#4`) failed
at the deployer with:

```
Failed to apply Deployment/catalog-api (HTTP 422):
Deployment.apps "catalog-api" is invalid: spec.template.spec.containers[0].image: Required value
```

The manifest was correct. It said `image: "{{image}}"`, exactly as its brief required. The empty
value came from the platform: `{{image}}` is filled only when the workspace's Kubernetes
connection carries `imageTemplate` (`KubernetesEnvironmentProvider.ts`), the acceptance connection
sets none, and `renderTemplate` resolves an unknown key to `''`
(`kubernetes-environment.logic.ts`).

That run is the whole rationale for this initiative, in both directions:

- Nothing recovered. The run died four steps in with six steps never reached, and the only
  recovery available was a human retrying an identical broken configuration.
- An agent handed that failure and a checkout would have had exactly one move: hard-code a real
  image into `deployment.yaml`. The run goes green, per-PR image substitution is permanently
  defeated, and the unwired connection the failure was reporting is hidden from the suite whose
  job is to detect it.

**The governing rule this produced: the fixer is not allowed to be the thing that discovers a
config failure.** Classify before dispatching, and refuse to spend a container on a class no
checkout edit can fix.

## Decisions

### The deployer escalates; there is no separate health gate

An earlier cut of this work put the loop in a `deploy-health` GateDefinition after the deployer
(probe the environment handle, escalate on a negative verdict, `onExhausted` for the give-up).
That was withdrawn. The deployer already owns provisioning through to a terminal verdict
(`pollDeployerJob` → `settleDeployerFrame` resolves the handle), so a gate probing the environment
status would re-read what the deployer had just written: duplicated functionality. The gate shape
is only correct if checking the deployment OUTCOME is not the deployer's responsibility, and it is.

Escalating from the deployer also removes two costs the gate version carried:

- **No persisted failure reason.** The classified cause is in hand at `settleDeployerFailure`
  (kernel's `getErrorReason` off the thrown `DomainError`), so nothing needs `lastErrorReason` on
  `EnvironmentHandle` and there is no D1 ⇄ Drizzle migration.
- **No change to when a run fails.** A primary-frame provisioning failure stays terminal. It gets
  one bounded remediation attempt first, and falls through to the byte-identical terminal failure
  whenever the loop does not apply.

This is NOT another `evaluateX` / `pollX` / `awaiting_x` triple (the thing CLAUDE.md bans): the
deployer already has its own poll path and its own `awaiting_job` park, and the loop rides both.
The gate would have been the new machinery.

### Classification is the precondition, not a refinement

`isRepoFixableEnvironmentFailure` admits ONLY `manifest_invalid` — the apiserver rejecting the
document on its own merits with every substitution resolved. Everything else (config incomplete,
image unavailable, workload unhealthy, permission denied, cluster unreachable, timeout, runner
unwired) is a cause no edit in the checkout addresses, and an unclassified failure is not fixable
either: "we could not tell what went wrong" is not evidence that an edit would help.

`image_unavailable` is deliberately excluded even though it looks repo-shaped. The image is
published by CI, so an agent chasing "no image to pull" is one step from editing the workflow that
builds it, and a workflow edit that merges is a credential-exfiltration path.

### The proof is a re-provision, never the model's reply

A repair is established by a subsequent provision verdict from the provider, not by what the agent
says it did. Same rule as the teardown probe (only a `confirmed` probe is a reclaim) and the bugfix
reproduction proof (only red-then-green is proof). This is why the fixer has no structured verdict
channel and no `FINAL_ANSWER_IN_REPLY`: its product is a pushed commit, exactly like the `ci-fixer`.

## Slice 1 — classification (landed)

- `environmentFailureReasonSchema` extended from one member to eight, with
  `isRepoFixableEnvironmentFailure` as an exhaustive `Record` so a new cause fails the build until
  somebody decides about it. (`contracts/src/environments.ts`)
- Provider-neutral seam in kernel so a backend registered into `EnvironmentBackendRegistry`
  participates identically, not just the built-ins: `environmentFailure()`,
  `unresolvedPlaceholders()`, `describeUnfilledConfigPlaceholders()`.
  (`kernel/src/domain/environment-failure.ts`)
- Kubernetes-specific classifiers: `classifyApplyFailure`, `classifyWorkloadFailure`,
  `KUBERNETES_CONFIG_PLACEHOLDERS`.
  (`integrations/src/modules/kubernetes/environment-failure.logic.ts`)
- Pre-apply refusal: a provision whose placeholder cannot be filled is refused BEFORE the apply,
  naming the placeholder, the connection field that fills it, and that the repository is not at
  fault. Applying anyway is what produced a rejection describing the rendered result and blaming
  the file. **Scoped to placeholders a CONNECTION FIELD fills.** The first cut refused on any
  unresolved key, which fails an ordinary provision: `frontendOrigins` is absent for a service no
  frontend binds, `peerEnvUrls` for the first frame of a fan-out, `branch` and `pullNumber` for a
  peer frame with no PR context. Each renders empty on purpose, so a template folding one into a
  CORS list is correct, and refusing it produced a `config_incomplete` naming no setting anyone
  could change. The refusal is worth having exactly where an operator can act on it.
- Apply failures throw a classified `DomainError` instead of a bare `Error`.
- **The rejection allow-list decides in BOTH directions.** 400/415/422 carry more than document
  rejections (a 400 can be `Timeout`, `Conflict` or `Forbidden`, and an unparseable body is as
  likely a proxy error page), so a reason outside `MANIFEST_REJECTION_REASONS` degrades to
  unclassified rather than falling through to `manifest_invalid`. The first cut returned
  `manifest_invalid` from both arms, which made the allow-list dead code and would have spent a
  fixer on manifests that were never at fault.
- Fixtures are the real `exec_194b231198454c7785f29589` payload, not invented examples.

## Slice 2 — the remediation loop (landed)

- [x] `DeployFixController`: escalates from `settleDeployerFailure` when
      `isRepoFixableEnvironmentFailure(getErrorReason(error))`, parks on the fixer job, re-provisions
      on completion by clearing that frame's `deployEnvs` entry, and falls through to the existing
      terminal failure otherwise. Returns `null` for "does not apply" so the pass-through is
      byte-identical to today.
- [x] Poll routing: a deployer step's in-flight job is normally a container-backed DEPLOY polled
      through the provisioning service. While the loop is fixing it is an AGENT job on the executor
      path. The two share `step.jobId`, so `step.deployFix.phase` is what tells them apart.
- [x] Attempt budget + per-round record (`step.deployFix.attemptLog`), in the `ciMaxAttempts`
      shape. The bar is FROZEN at the first escalation, so a mid-run pipeline edit cannot move
      what the spent rounds were counted against.
- [x] `recordDispatchAttribution` on the fixer dispatch.
- [x] Give-up disposition: **a plain terminal failure plus a `deploy_blocked` card**, and NOT a
      park. The earlier cut parked attended runs so a human could confirm external blockers were
      cleared, which only made sense while the fixer was the thing that discovered them.
      Classification upstream is what handles those now, so exhaustion means two failed attempts at
      a genuinely invalid manifest: a failure to report, not a decision to ask for. That also
      settles the ADR 0053 question by removing it, since nothing waits.
- [x] `deploy_blocked` notification type: the picklist, `notification-routing`,
      `notification-webhooks`, the exhaustive email/Slack `Record`s, `notificationActions` (the
      `ci_failed` retry), the SPA inbox maps and all ten i18n locales with real translations.

- [x] The classification reaches the loop from BOTH routes a failure arrives by. A provider that
      THROWS states its cause on `details.reason`; one that settles a `failed` environment instead
      states it on `ProvisionedEnvironment.reason`, which the provisioning service carries beside
      the handle as `SettledProvision`. Returning the handle alone dropped it one call before the
      decision that needed it, so every non-throwing failure read as unclassified. Deliberately not
      a column on the environment row: the reason is consumed in the same call that produces it.

Still open in this slice:

- [ ] **A structured cause from the deploy harness**, which is what the container-backed path needs
      before it can remediate at all. `mapDeployOutcome` has only the free-form output of
      `kubectl`/`kustomize`/`helm`, never an apiserver `Status`, so a kustomize or helm render
      settles UNCLASSIFIED and the loop declines it. That is deliberate rather than pending: a
      manifest whose `{{image}}` was never substituted fails that path with a validation error
      indistinguishable from genuinely wrong manifests, so phrase-matching the text would dispatch
      a fixer at the exact failure this feature exists to keep it away from. The fix is the deploy
      harness reporting a cause on its own outcome channel (an image bump), after which the pipe
      above already carries it.
- [x] Every attempt on the record in the PR verification report, so a human reviewing the PR sees
      that deployment files were machine-edited and why:
      `environments.entries[].remediation.deployFix` carries the rounds, the frozen budget, the
      classified cause, and the split between rounds whose job FINISHED and rounds that died
      having changed nothing (a bare count reads as the first). Filed downstream as
      [#2181](https://github.com/kibertoad/cat-factory/issues/2181), landed with the
      investigation's half of the same section. It also needed the loop-back reset fixed:
      `resetStepForRerun` dropped the whole of `deployFix`, so a frame the fixer had edited before
      a `human-test` loop-back reported as one nothing was ever attempted on. The counters are now
      re-armed per provisioning CYCLE and the attempt log survives the RUN
      (`restartDeployFixState`).
- [ ] The run outcome summary is deliberately NOT the second home for it. That section answers one
      question in product language, "is there something running to click", and a fault layer plus a
      withheld action is operator-facing engineering detail a non-code reader cannot act on. If a
      surface is wanted for a person rather than a reviewer it is the run-details panel, which is
      `environment-investigation.md`'s slice 4.
- [ ] Server-side apply does not prune: a resource the fixer DELETES from the manifests stays live
      in the namespace and can keep serving the environment. Either prune by field manager or state
      plainly that it does not.

## Slice 3 — better inputs

Each of these makes the classification sharper; none blocks slice 2.

- [ ] Pod-level terminal reasons in `deploymentStatus`. It reads Deployment `.status` only, so
      `ImagePullBackOff` / `CrashLoopBackOff` / unschedulable / `OOMKilled` all read as "still
      provisioning" until the deadline and then arrive as a generic timeout. `analyzePodStatus`
      (`kubernetes.logic.ts`) already does this walk for executor pods, and
      `classifyWorkloadFailure` is written and tested against its output shape but is NOT YET
      CALLED. Reusing it is the highest-value remaining input.
- [ ] File identity. `readManifests` returns texts and drops the file name before `parseManifests`,
      so an apply error cannot say which file, or which document inside it, produced the resource.
      Without this a fixer is guessing which file to edit.
- [ ] Record the RENDERED manifest, not only the source. Seeing `image: ""` rather than
      `image: "{{image}}"` is the difference between "edit this file" and "do not touch this file".
- [ ] The provider error reaches the debug overview and the provisioning log truncated mid-JSON.
- [ ] No commit sha anywhere: `PullRequestRef` is `{ url, number?, branch? }`. A repair that needs
      a sha-tagged image needs the sha added to the platform first. A SECOND consumer of the same
      gap has since arrived from outside: a provider whose diagnostic artifacts are addressed by
      commit cannot fetch them, because there is no sha to hand its `describe`
      ([#2181](https://github.com/kibertoad/cat-factory/issues/2181), tracked as the paired item in
      `environment-investigation.md` slice 3, which is gated on this one). That makes the sha a
      run-level fact rather than a fixer input: resolve and record it ONCE, where the diagnostics
      request, the merge decision and the verification report can all read it.

## Slice 4 — write-path scope

- [ ] Constrain fixer edits to the service's `provisioning.manifestSource.path`. Model-authored
      paths are validated for MAGIC, not just traversal (`--` stops a path being read as a revision
      and does nothing about `:(glob)**`), and a refused input is REPORTED as an omission rather
      than silently dropped.
- [ ] Keep it out of `.github/workflows`. The scaffold briefs have agents authoring exactly such a
      workflow, so this will come up. The `deploy-fixer`'s directives half already states the
      prohibition (it is on the directives side precisely so a workspace prompt override cannot
      delete it), but a prompt is not a mechanism and this needs enforcing at the write boundary.
- [ ] Changing what the write path allows updates
      [`security-model.md`](../../backend/docs/security-model.md) in the same PR. That is the
      doc's own rule.

## Slice 5 — acceptance suite

- [ ] `backend/internal/acceptance/src/decisions.ts` answers follow-ups and clarity-review and
      hard-fails on every other kind by design. Any new park kind aborts an acceptance pass at
      first sight: register it there, or give it an explicit unanswerable reason.
- [ ] `driveRun`'s budget spans the whole run and `ACCEPTANCE_RUN_BUDGET_MS` defaults to 90
      minutes. A repair loop of several container dispatches will eat it. Re-size before landing.
- [ ] The suite's own missing `imageTemplate` is being fixed separately. This loop must not be what
      makes scenario 01 pass.

## When the committed scope completes

Convert this tracker into a numbered ADR under `backend/docs/adr/` and `git rm` it in the same PR.
Keep Context / Decision / Rationale / Consequences, drop the checklists. Check the next free number
against ALL existing files first: parallel branches have collided on one three times.
