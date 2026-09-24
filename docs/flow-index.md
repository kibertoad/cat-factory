# Pipeline flow index

An INDEX of the runtime flows: what each flow is, plus the trap a change would hit. The linked doc
is the authority, and new flow detail belongs THERE, not here; an entry stays a handful of lines.

The cross-cutting rules these flows established (concurrency and idempotency, untrusted text,
degrade loudly, the harness rules) are stated once in the root [`AGENTS.md`](../AGENTS.md), which
is where a rule binding more than one flow goes. The step vocabulary an entry assumes (agents,
gates, one-shot engine steps, judges, companions) is
[`step-taxonomy.md`](../backend/docs/step-taxonomy.md).

**Built-in catalog lifecycle**: built-ins are COPIED into each workspace at creation and reconciled
against the CATALOG, never the stored row; a run ADOPTS an entry the board was never seeded with, so a
PINNED pipeline is never stuck behind an advisory. Traps: retiring one is TWO edits (definition AND
`buildRetiredPipelines()`), the first alone a silent no-op; a bare `pipelineRepository.get` on a
run-adjacent path is the smell, since every start gate resolves the pipeline and CONCLUDES from it; and
an AUTHORING rule (`validatePipelineAuthoring`) binds create/update, the run door refusing only the
subset that dead-ends ANY run, or every stored pipeline predating it stops running. Doc: [`pipeline-catalog-lifecycle.md`](../backend/docs/pipeline-catalog-lifecycle.md).

**Repo bootstrap** mirrors the execution pattern: `BootstrapService` → `bootstrap_jobs` →
`BootstrapWorkflow` polling the idempotent `pollBootstrapJob()`, then links the repo and flips the frame
`ready`; pre-flights an EMPTY target, its prompt riding Pi's global `AGENTS.md` so it never lands there.
Targeting a DIRECTORY of an EXISTING repo splits the run into two drives around a human adoption review (a BOUNDED tool-loop survey → park `awaiting_review` → write); `delivery` then picks PR vs push, defaulted per TARGET and PERSISTED (a retry re-dispatches under it). Traps: a parked run is neither `running` nor terminal, so it takes its OWN `driveId`; the plan is checked against the transcript the loop LEFT, never the opening snapshot; only a run that PROMISED a PR fails for reporting none. [Doc](./initiatives/monorepo-service-bootstrap.md).

**Service blueprints**: a Blueprinter agent decomposes a repo into service → modules and persists it IN
THE REPO under `blueprints/`: no table, because the files are the truth and the board is the projection.
The map stops at modules and tasks are authored by people, so `reconcileBlueprint` matches by name, adds
missing, refreshes descriptions, and **NEVER deletes or touches authored tasks**.

**In-repo spec implementation state**: `requirementItem.state` (`aspirational` ⇄ `established`) keeps an
agreed-but-unbuilt requirement out of build prompts. Trap: `specPromotionPostOp` is the ONE author and
it NEVER demotes; `coerceRequirement` defaults a garbled state to `aspirational`, so a model cannot promote
by assertion. Doc: [`service-acceptance-criteria.md`](./initiatives/service-acceptance-criteria.md).

**Pre-dispatch input gate**: a deterministic reduction over a task's OWN authored fields, run at step 0
before the first dispatch, parking the run for FREE when there is structurally nothing to act on.
Trap: it is not a cheap reviewer, so it never scores prose or infers intent and every BLOCKING finding
names an input no model could have acted on either. Doc:
[`pre-dispatch-input-gate.md`](./initiatives/pre-dispatch-input-gate.md).

**Requirements review**: an inline iterative loop (review → answer → incorporate → re-review) settling the
PRODUCT layer only, its findings sorted into the two groups that decide WHO answers. Trap: the reviewer
must be TOLD what system the work is about; a derived subject never displaces it. [`requirements-review.md`](../backend/docs/requirements-review.md).

**Inbound tracker webhooks**: HMAC over the RAW body before any parse, ack 202, hand off through
`gateways.trackerWebhook`; unconfigured FAILS CLOSED. Trap: the per-ticket match is a VERDICT
(`unconfirmed` fires `queue` and withholds `per-ticket`), never a boolean. [ADR 0032](../backend/docs/adr/0032-tracker-webhook-intake.md).

**Bug hunt**: scan a tracker board's open unassigned bugs, rate impact against complexity, adopt one onto
`pl_bugfix`; persists NOTHING. Trap: the rating takes `isOverBudget`, being the platform's first billable
call no run start gates, and any future un-run-scoped LLM call owes it too. [`bug-hunt.md`](../backend/docs/bug-hunt.md).

**In-app assistant**: one typed request, routed by an inline model that NAMES and COPIES and resolves
nothing, to ONE action from a closed catalog the platform then performs through the board's own services.
Deadliest trap: a `needs_input` CANDIDATE is answered back as DATA into the field the outcome names, so an
action offering one its own next turn refuses asks a question that never terminates. [`in-app-assistant.md`](../backend/docs/in-app-assistant.md).

**Bug fishing expedition**: a read-only hunt for the defects nobody reported. ONE `bug-fisher` step,
dispatched once per ANGLE per platform-computed TERRITORY; a human MARKS what to fix and each mark spawns
its own task on the board's `bugFishingFixPipelineId`, else `pl_bugfix_tested`. Trap: marking is accepted
MID-hunt, so the state survives `resetStepForRerun` and every reduction is over the ACCUMULATED catch. Doc: [`bug-fishing-expedition.md`](./initiatives/bug-fishing-expedition.md).

**Implementation-fork decision**: an optional two-phase `coder` step that proposes materially different
implementations and parks for a human BETWEEN two dispatches on the same step (a container job can't
pause mid-run). Rides `step.forkDecision`; primary repo only. Doc:
[ADR 0022](../backend/docs/adr/0022-coder-fork-decision.md).

**Dependency prepopulation**: one declared install command run before the agent's first turn. Trap:
NEVER a gate; an install is SETUP, so every failure becomes a prompt NOTE and the run continues. Doc:
[`agent-dependency-prepopulation.md`](./initiatives/agent-dependency-prepopulation.md).

**Foundational services**: a tiered (builtin ⊕ account ⊕ workspace) catalog of the shared capabilities an
org already runs, injected as `.cat-context/` files; supplied by upload, a linked repo or an IMPORTED
developer portal. Trap: catalog and CONTRACTS are two separate reads and that split IS the feature. Docs: [ADR 0031](../backend/docs/adr/0031-foundational-services.md), [import](../backend/docs/service-catalog-import.md).

**Binary-output steps**: a `binary-output`-trait kind generates artifacts, stored through a foundational
service its step SELECTS; what MAKES them is `BinaryGeneratorRegistry`, read only via `BinaryGeneratorSource`
(unreachable ⇒ 503, mothership rule). Deadliest trap: content type is CLOSED and stops deciding at the
SECOND producer, so overlaps are STATED, never ranked. Doc: [`binary-output-foundational-storage.md`](./initiatives/binary-output-foundational-storage.md).

**Compose layers**: `StackRecipe` / `SharedStack` name an ORDERED list of `ComposeFileRef` layers
(in-repo path, `inline`, or `repo`), letting a deployment declare infra dependencies in code. Traps: the
project directory anchors on the first `path` layer, NEVER the first layer. Doc:
[`stack-recipes-and-shared-stacks.md`](./initiatives/stack-recipes-and-shared-stacks.md).

**Pre-PR validation**: per-frame install/lint/test/build commands after the agent settles; only a green
checkout opens a PR. Traps: autodetection SUGGESTS, it never writes; unconfigured is byte-for-byte the
old behaviour. Doc: [`pre-pr-validation.md`](./initiatives/pre-pr-validation.md).

**Bugfix reproduction proof**: the declared reproduction command against the pre-fix tree and the PR
tree; only red-then-green is proof. Traps: SYMMETRY between the two trees is the safety property; target
`baseSha` and apply the declared PATHS only; a failure degrades to `inconclusive` with the PR still
opening (the opposite disposition from validation); the producer's `note` is rendered VERBATIM. Doc:
[ADR 0033](../backend/docs/adr/0033-bugfix-reproduction-proof.md).

**Pipeline PR descriptions**: the agent writes its reviewer briefing to `.cat-pr-description.md` and the
harness lifts it onto `openPullRequest`; when the target repo ships a PR template, the briefing IS that
template, filled in. Trap: the guidance rides EVERY agent pass, so the coverage test classifies every
agent-running mode as PR-opening or not. Doc: [`pipeline-pr-descriptions.md`](../backend/docs/pipeline-pr-descriptions.md).

**Delegated executors**: a step runs in a system the DEPLOYMENT already operates, on
`DelegatedExecutorRegistry` + an `agent.surface: 'delegated'` kind; everything around it (intake,
standards, `ci`, the merge policy, notifications) is the engine unchanged. Deadliest trap: both drivers
REPLAY, so the engine commits a delegation CLAIM before `start()` and the executor owes idempotency per
`correlationKey`, or one task gets two external runs and two PRs. Doc: [`delegated-executors.md`](../backend/docs/delegated-executors.md).

**Consensus panels**: an eligible step runs as a multi-model panel (`@cat-factory/consensus`). Traps: a
panel participant has NO checkout and `dispatchDeliversCheckout` is the one definition every layer asks;
the tier is chosen by the ENGINE at dispatch, deterministically. Doc:
[`consensus-panels.md`](../backend/docs/consensus-panels.md).

**Merge lifecycle** turns an open PR into a merged one, gated on REAL CI and a REAL merge, so a task is
`done` only when its PR actually merged.

- **`ci` (polling gate)**, auto-inserted second-to-last: green/none advances with nothing spun up,
  pending sleeps, failure dispatches `ci-fixer` (which pushes back onto the SAME branch) up to
  `ciMaxAttempts` then raises `ci_failed`.
- **`merger`** (last standard step) returns ONLY a JSON assessment; `resolveMergerStep` scores it against
  the task's risk policy (an account ⊕ workspace library of ceilings, budgets and per-class `classRules`,
  read by editor/picker/engine alike through the ONE merged `WorkspaceRiskPolicyReader`: [ADR 0055](../backend/docs/adr/0055-account-scoped-risk-policies.md))
  and either merges for real or raises `merge_review`. No merger ⇒ `pipeline_complete`, never auto-`done`.
- **Who started the run is part of the merge policy**, and a bar on LANDING is refused at BOTH exits
  (auto-merge AND `mergePr`). Deadliest trap: the role and mode PIN at admission and count only if the pin
  PERSISTS through `executionToDetail` / `rowToExecution` / `buildResumedInstance`, so a dropped pin reads
  as a run with no policy rather than as an error.
  [ADR 0037](../backend/docs/adr/0037-role-scoped-merge-policy.md),
  [ADR 0039](../backend/docs/adr/0039-role-scoped-submission-allowlists.md).
- **Merge track record** persists each decision best-effort. Trap: an unreadable diff yields `unknown`,
  which never matches a rule, so a VCS outage cannot change policy.
  [ADR 0046](../backend/docs/adr/0046-merge-track-record.md).
- **Whether a run WAITS is policy too**: `autonomy` answers the parks the engine's loops raise WHEN THEY
  GIVE UP, on the record; a workspace holds TWO defaults for it AND for its pipeline, scoped by
  `runDefaultScopeFor(intakeOrigin)`. Traps: never a park the PIPELINE asked for; a new give-up park picks
  a side; a review's QUESTIONS settle only where a SECOND, independent judgement agrees.
  [ADR 0053](../backend/docs/adr/0053-unattended-run-autonomy.md), [ADR 0054](../backend/docs/adr/0054-per-scope-pipeline-defaults.md).
- **Notifications** (`NotificationChannel`) and run-lifecycle events (`RunLifecycleSink`) are built together
  by `buildNotificationWebhookSupport` onto ONE registered endpoint and the ONE `signedDelivery.ts`
  retry/SSRF/signature core. Traps: the started edge is exactly-once via `handOffLiveRun` (announced LAST,
  after the claim and the local write); the terminal edges are at-least-once with a `<runId>:<event>` dedupe
  id a receiver dedupes on, never on the body. [ADR 0030](../backend/docs/adr/0030-public-api-surface.md).

**Run evidence reductions**: the ENGINE keeps a verification report of captured facts on EVERY pull request
a run opened (marker-delimited body section, idempotent, no persisted state) and reduces the same evidence
into the OUTCOME summary the SPA card renders and `/api/v1/runs/:runId/outcome` serves. Traps: composing is
a settlement HOOK reading in-memory state, never a re-probe; a peer's copy WITHHOLDS the own-service-only
sections, so the write-avoidance cache keys per TARGET; a rule BOTH reductions state (which testers count,
regressions, coverage) lives in contracts' `run-evidence.ts`. Doc: [`pr-verification-report.md`](./initiatives/pr-verification-report.md).

**Environment disposal**: the `disposer` step reclaims what the run provisioned where its author placed
it, every teardown path re-probes afterwards, and a SAVE refuses a chain that neither reclaims nor says
the environment outlives it. Deadliest trap: a no-op `teardown:` reports `torn_down`, so only a
`confirmed` probe is a reclaim and a missing verify row is never a pass. Doc: [`environment-disposal-and-teardown-proof.md`](./initiatives/environment-disposal-and-teardown-proof.md).

**Post-release health**, the LAST standard step: watch monitors/SLOs for a window and, on a regression,
spawn an `on-call` agent to investigate. **It never auto-reverts.** The kernel `ReleaseHealthProvider`
port is vendor-neutral (per-vendor adapters, today only Datadog); credentials live sealed in
`observability_connections`, never in containers. `on-call` is resolved by `resolveOnCallStep`: raise
`release_regression`, best-effort enrich any open incident (the `IncidentEnrichmentProvider` port
annotates, never re-alerts), finish the gate.
