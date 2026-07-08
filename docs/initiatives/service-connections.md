# Initiative: connections between services

## Goal & rationale

Services on the board are islands: a task targets exactly one service frame → one repo →
one PR → one ephemeral environment. Real systems have inter-service relationships
("the Auth service uses the Email service to send its mail"), and a task on one service
may need a connected service spun up for testing AND changed in the same piece of work.
This initiative adds directed **connections between service frames**, a per-task
**"involved services"** selector, **multi-env provisioning** (every involved service gets
an ephemeral environment), and **multi-repo coding** (one container, sibling checkouts,
one PR per dirty repo, all-green-then-merge-all).

Full design (the source of truth for every phase — do not re-derive):
[`backend/docs/service-connections.md`](../../backend/docs/service-connections.md).

## Target pattern

Phase 1 (this initiative's pilot PR) is the reference implementation for how the model is
shaped and validated end to end: consumer-side JSON edges on the frame block
(`serviceConnections` — a single mapper entry both stores pick up), a task-level
`involvedServiceIds` selection validated against the undirected neighbor set
(`connectionNeighborIds`, shared SPA + server), write-gate validation in
`BoardService.updateBlock` with pure rules in `board.logic.ts`, delete-time pruning in
`pruneDanglingEdges`, board edges in `TaskDependencyEdges.vue`, and inspector panels
(`ServiceConnections.vue`, the "Involved services" section of `TaskRunSettings.vue`).

## Phase checklist

### Phase 1 — connection model + involved-services selector

| Item                                                                                            | Status |
| ----------------------------------------------------------------------------------------------- | ------ |
| Contracts: `service-connections.ts` + `blockSchema`/`updateBlockSchema` fields                  | done   |
| Persistence: D1 `0034_service_connections.sql` ⇄ Drizzle columns + shared mapper entries        | done   |
| BoardService: write-gate validation + delete-prune + unit tests                                 | done   |
| Board edges (emerald consumer→provider set in `TaskDependencyEdges.vue`)                        | done   |
| Inspector: `ServiceConnections.vue` panel + `TaskRunSettings.vue` involved-services section     | done   |
| i18n: `inspector.serviceConnections.*` + `inspector.runSettings.involvedServices*`, all locales | done   |
| Conformance: JSON-column round-trip + write-gate 422s on both stores                            | done   |
| Design doc + this tracker                                                                       | done   |

### Phase 2 — multi-env provisioning (design in the doc, §Phase 2)

| Item                                                                                                 | Status |
| ---------------------------------------------------------------------------------------------------- | ------ |
| `supersedePriorEnvironment` keyed per `(blockId, frameId)` (BLOCKER for fan-out)                     | done   |
| `runDeployerStep` fan-out: one deploy job per involved frame, provider-first, per-frame step state   | done   |
| `deployerProvisionArgs` gains `peerEnvUrls` inputs (beside `frontendOrigins`)                        | done   |
| `AgentContextBuilder` resolves `involvedServices` (title/description/envUrl), read-time stale filter | done   |
| `testerInfraSpec` gains `peerEnvironments` map; harness `AgentInfraSpec` extension (image bump)      | done   |
| Conformance: multi-env provisioning + peer-URL resolution on both runtimes                           | done   |

### Phase 3 — multi-repo coding (design in the doc, §Phase 3)

| Item                                                                                                     | Status |
| -------------------------------------------------------------------------------------------------------- | ------ |
| `resolveRepoTargets` (plural) beside the singular resolver; dedupe by repo; monorepo `serviceDirectory`s | done   |
| `AgentJob.peerRepos` + sibling-checkout workspace layout in the harness (image bump)                     | done   |
| Push/PR fan-out: same `cat-factory/<blockId>` branch per repo, PR only for dirty repos                   | done   |
| `AgentRunResult.peerPullRequests` + `block.peerPullRequests` + `allPullRequests(block)` helper           | done   |
| Multi-repo prompt section (peer roles from connection descriptions) + `AGENTS.md` note                   | done   |
| Conformance: two-repo coding run records both PRs on both runtimes                                       | done   |

### Phase 4 — gates + merger generalization (design in the doc, §Phase 4)

Implemented in **PR #761** (branch off #752). **Zero harness edits** (per the bug-triage
tracker convention): the ci-fixer reuses the existing `runMultiRepoCoding` sibling-checkout
harness path via a widened `peerRepos` job body — no runner-image bump. `step.gate.headShas` /
`conflictTarget` ride the existing gate-state JSON (no migration).

| Item                                                                                                   | Status                                 |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| CI gate aggregates across PRs (`step.gate.headShas` map); fixer runs in the sibling-checkout container | done                                   |
| Conflicts gate per PR; single-repo conflict-resolver dispatched at the conflicted repo (own or peer)   | done (peer targeting landed; see †)    |
| Merger: combined-diff assessment + all-green-then-merge-all in provider-first order                    | done (combined-diff landed; see ‡)     |
| Mid-sequence merge failure → block `blocked` + notification enumerating merged vs unmerged             | done                                   |
| Conformance: multi-PR gate + merge-all behaviour on both runtimes                                      | done (CI aggregate + conflicts; see §) |

- **† Conflict-resolver peer-repo targeting — LANDED.** The conflicts gate now ESCALATES a
  peer-repo conflict (it no longer returns `escalatable: false`); it tags the conflicted repo on
  `step.gate.conflictTarget`, the engine threads that onto the dispatched `conflict-resolver`'s
  `AgentRunContext`, and `ContainerAgentExecutor` points the (single-repo) resolver AT that peer
  repo — resolving its target, cloning its PR (work) branch, and merging the peer's base in — via
  `resolveRepoTargets`. The peer-only case (own service unchanged, no own PR) pins the resolve
  branch to the shared work branch. Own-repo conflicts are unchanged (no `frameId` ⇒ implicit own
  target). Asserted by the conflicts-gate conformance case (escalation) + the server job-body unit
  test (peer repo/branch/mergeBase swap).
- **‡ Merger combined-diff — LANDED.** The `merger` now scores the COMBINED cross-repo change:
  driven by `block.peerPullRequests`, it clones each peer PR's repo as a read-only sibling at its
  PR branch (full history) beside the own service, and a "Multi-repo pull request" prompt section +
  the reworked merger prompts have it diff each repo vs its base and return ONE blended assessment.
  Needed a harness bump — the read-only multi-repo explore path gained per-peer `cloneBranch` +
  honours `full` (the bug-investigator's base-branch fan-out is unchanged). The engine's merge-all
  (`orderPrsForMerge`) was already multi-repo aware.
- **§ Multi-repo gate conformance.** Multi-repo CI aggregation + ci-fixer escalation AND the
  conflicts gate escalating a peer conflict are asserted on every runtime in the conformance suite;
  the merge-all ordering + provider fan-out are unit-tested (`mergeOrder.logic.test.ts`,
  `multiRepoGateProviders.spec.ts`), and the merger's combined-diff dispatch (peer sibling
  checkouts) is unit-tested in the server job-body spec (the fake executor never runs the harness).

## Conventions & gotchas carried between iterations

- **Decisions already made — do not re-litigate**: directed consumer-side edges;
  connection cycles are LEGAL (deterministic order inside a cycle: primary first, then
  frame id); `block.pullRequest` stays singular with `peerPullRequests` beside it;
  sibling checkouts in ONE container (rejected: read-only peers, coordinated multi-job);
  all-green-then-merge-all with accepted non-atomicity.
- **Runtime symmetry**: every persisted/behavioural change lands in BOTH runtimes + a
  conformance assertion in the same PR (phase 1's round-trip test is the model).
- A new block field is ONE shared-mapper entry (`mappers.ts`) + one column in each store;
  empty-array-clears fields need the custom `serviceFragmentIds`-style entry, not
  `optJsonField` (an empty array is truthy and would persist `"[]"`).
- **Stale `involvedServiceIds` are inert, never fatal**: write-gate validates, execution
  re-filters at read time, the UI badges and drops them on the next toggle.
- **Cross-home mounted services**: connection-target validation goes through the
  cross-home-aware `resolveBlock`; the server-side neighbor check for `involvedServiceIds`
  uses the home workspace's block list and may miss a cross-home REVERSE edge — a known
  phase-1 limitation to revisit when shared-service usage grows.
- Phases 2 and 3 touch the executor-harness (`AgentInfraSpec` / `peerRepos`): bump
  `@cat-factory/executor-harness` + the three pinned image tags per the CLAUDE.md rules.
- An involved frame with no linked repo provisions an env but is skipped for coding —
  the asymmetry is deliberate.
- Two branches adding Drizzle migrations merge into "Non-commutative migrations": re-root
  with `node scripts/rebase-migration-snapshot.mjs <later-folder>` (see CLAUDE.md).
- **Phase 3 carried-forward notes:**
  - `resolveRepoTargets` (`@cat-factory/server`, beside the singular resolver) shares the same
    store deps, hoists the installation + projection reads ONCE and batches involved frames via
    `serviceRepository.listByFrameBlocks` — do NOT loop the singular resolver per frame (N+1).
    It returns `RepoCheckout[]` (primary first) deduped by `owner/name`; each carries the
    involved frames co-located in it (`involved[]`) so a monorepo hosting several involved
    services is ONE checkout with all their subdirs noted for the prompt.
  - The fan-out is gated to the `coder` implementer (`IMPLEMENTER_AGENT_KIND` in
    `ContainerAgentExecutor`) and only when `context.involvedServices` is non-empty. In
    multi-service mode the primary's `serviceDirectory` scoping is DROPPED so the agent works at
    the repo root and can reach every involved subtree (co-located monorepo services included);
    the "Multi-repo workspace" prompt section (`renderMultiRepoWorkspaceSection`) names where
    each service lives. Phase 4 must extend this to the gate helpers (`ci-fixer` etc.) which are
    still single-repo (they take the `onPr` path, which does NOT emit `peerRepos`).
  - The harness multi-repo flow (`runMultiRepoCoding`) is deliberately simpler than the
    single-repo `runCodingAgent`: NO mid-run checkpoint pushes, NO warm-pool persistent checkout,
    NO follow-up streaming. If phase 4 needs any of those across repos, generalize there.
  - `peerPullRequests` is engine-written (RunDispatcher), NOT in `updateBlockSchema`; the JSON
    column uses the empty-array-clears mapper pattern. The conformance test exercises the
    RECORDING + round-trip (the fake reports peer PRs); the resolve→peerRepos dispatch path is
    unit-tested in `resolveRepoTarget.spec.ts` + the server job-body specs (the fake never runs
    the harness). Phase 4's CI/merge-all reads `allPullRequests(block)`.
- **Phase 3 review-fix follow-ups (PR #752 review; the coordination + prompt fixes LANDED,
  the items below are the deliberately-deferred remainder):**
  - **Landed** (see the review-fixes commit): the sibling checkout dir is now deterministic
    (`owner__name`) and computed identically in the harness (`siblingDir`, `coding-agent.ts`)
    and the backend prompt (`siblingCheckoutDir`, `jobBody.ts`) so the prompt never names a
    directory that doesn't exist; `renderMultiRepoWorkspaceSection` renders a distinct
    "multi-service repository" (single-repo, one PR) shape when there are no peer checkouts
    instead of falsely claiming siblings; the multi-repo prompt tells the agent to commit
    INSIDE each repo dir (the workspace root is not a git repo — untracked files are lost);
    `streamFollowUps` is no longer advertised on the multi-repo path (which never tails the
    sentinel); resumed multi-repo legs refresh from base like the single-repo path; a run
    whose own service was a no-op but a peer changed surfaces the peer PRs in its output; and
    the multi-repo dispatch reuses the already-resolved primary `RepoTarget` (no second
    installation read / ancestry walk).
  - **Deferred — all-frame peer-PR attribution.** A shared-monorepo peer checkout can carry
    `>1` involved frame (`RepoCheckout.involved[]`), but the peer PR is attributed to only
    `involved[0].frameId` end-to-end (`PeerRepoSpec.frameId`, `peerPullRequestSchema.frameId`,
    the gate `conflictTarget`, `mergeOrder`). Phase 4 keys its gates + merge-order off the
    SINGULAR `frameId`, so widening the whole chain to `frameIds[]` (contracts → kernel →
    harness → server → gates → mergeOrder + tests) is its own isolated change, not a rider on
    the review fixes. Until then a monorepo hosting several involved services links its single
    PR to just the first frame.
  - **Deferred — `runMultiRepoCoding` ⇄ `runCodingAgent` duplication.** The multi-repo flow
    re-implements the no-op-result object, the `hasWork`/resumed-branch detection, and the
    involved-frame level resolution rather than sharing helpers with the single-repo path /
    `walkToRepo`. Extract shared `noChangesResult` / `computeHasWork` / `resolveLevel` helpers
    when Phase 4 next touches these flows. Multi-repo clone + push/PR are also still sequential
    per repo (could be `Promise.all`), and it still lacks mid-run checkpoint pushing (the
    documented first-cut simplification) — an evicted large multi-repo run re-runs from scratch.
