# Connections between services

Services on the board can be **connected** — "the Auth service uses the Email service to
send its mail". A task then selects which connected services are **directly involved** in
it, with two consequences (phased in below):

1. Every involved service spins up as an **ephemeral environment** alongside the task's
   own service, so integration behaviour is testable for real.
2. The **coding agent may change code in every involved service's repo**, not just the
   task's own — a cross-service contract change (provider API + consumer call site) lands
   as one coherent piece of work.

This document is the full design. Phase 1 (the connection model + the per-task selector)
is implemented; phases 2–4 are designed here and tracked in
[`docs/initiatives/service-connections.md`](../../docs/initiatives/service-connections.md).

## The connection model (phase 1, implemented)

### Shape and storage

A connection is a **directed edge stored on the CONSUMER service frame**: an entry in the
frame block's `serviceConnections` array (`@cat-factory/contracts`
`src/service-connections.ts`) meaning "this frame USES the target service".

```ts
serviceConnections: [
  { serviceBlockId: '<provider frame block id>', description: 'sends transactional email via it' },
]
```

- **JSON column on the block (`service_connections`), not a dedicated table.** The
  snapshot already ships every block, so board-edge rendering and "all connections of a
  workspace" queries are free; the shared field-map mapper
  (`backend/packages/server/src/persistence/mappers.ts`) makes a JSON column a single
  entry both the D1 and Drizzle stores pick up. A table would cost a snapshot addition,
  two repositories, a kernel port, and conformance plumbing for no query we need.
  Referential cleanup — the one real advantage of a table — is handled by
  `BoardService.pruneDanglingEdges`, which already prunes the other JSON-carried edges
  (`dependsOn`, `epicId`) on delete.
- **Directed, consumer-side.** One canonical record per relationship (no dual-write, no
  conflicting duplicate descriptions); the direction gives phase 4's merge ordering a
  provider-before-consumer topology for free; and it mirrors the existing consumer-side
  precedent, the frontend frame's `backendBindings`. The inspector shows both directions:
  the frame's own editable "uses" rows plus a computed read-only "Used by" list.
- **`description` is prose for humans AND agents**: when the provider is involved in a
  task, the line is folded into the agent prompt to explain the relationship
  ("sends transactional email via it").

`type: 'frontend'` frames keep their existing `backendBindings` mechanism — a service
connection links `type: 'service'` frames only.

### Validation (write gate: `BoardService.updateBlock`)

Pure rules in `board.logic.ts` (`serviceConnectionsError` / `involvedServiceIdsError`),
enforced as `ValidationError` → 400:

- No self-connection; no duplicate targets.
- Each target must resolve (via the cross-home-aware `resolveBlock` path, so a service
  mounted from another home workspace connects too) to a `level: 'frame'`,
  `type: 'service'` block.
- The fields are silently dropped on blocks of the wrong level/type (the
  `serviceFragmentIds` pattern), so they never persist as dead data.
- **Cycles are ALLOWED.** A↔B mutual calls are ordinary architecture and nothing
  deadlocks on a cyclic connection graph. Phase 4's provider-before-consumer ordering
  falls back to a deterministic order inside a strongly-connected component (primary repo
  first, then ascending frame id). Do not re-litigate this in later phases.

Deleting a frame prunes every `serviceConnections` entry and `involvedServiceIds` entry
pointing at it (extension of `pruneDanglingEdges`); the board edge renderer additionally
skips unresolvable targets, so a half-pruned state never draws a ghost edge.

### Per-task involved services

A task block carries `involvedServiceIds: string[]` — the connected service frames
"directly involved" in the task **beyond its own service** (the own service is always
implicitly involved and never listed). Selection source: the frame's connection
**neighbors in either direction** (`connectionNeighborIds`, shared by the SPA selector
and the server-side write validation) — a task on either endpoint of a connection may
need the other service spun up or changed.

Validation tiers:

- Contract: shape only.
- BoardService (authoritative): dropped on non-tasks; each id must be a neighbor of the
  task's enclosing frame, never the own frame, no duplicates — over ONE
  `listByWorkspace` read.
- Execution read time (phase 2+): re-filter to ids that still resolve to connected
  frames. A connection removed after selection makes the stale id **inert, never a run
  failure**; the UI badges stale entries and drops them on the next toggle.

Execution contract for later phases: `AgentContextBuilder` resolves the task +
frame connections into one shape the deployer and executor both consume:

```ts
involvedServices: Array<{ frameId; title; description?; repoTarget?; envUrl? }>
```

### Board + inspector surfaces

- **Edges**: `TaskDependencyEdges.vue` draws consumer→provider arrows (emerald, dashed)
  as a fourth segment set beside task-dependency (amber), epic-member (violet) and
  frontend→service (cyan) edges.
- **Service frame inspector**: the `ServiceConnections` panel (rows of provider select +
  description input, plus the read-only "Used by" list), persisting the whole array via
  the shared `updateBlock` PATCH — modeled on `FrontendConfig.vue`.
- **Task inspector**: an "Involved services" checkbox list in `TaskRunSettings.vue`,
  offering the frame's current neighbors and badging stale selections.

## Phase 2 — multi-env provisioning (designed, not yet implemented)

Today `RunDispatcher.runDeployerStep` resolves ONE service frame's `provisioning` and
dispatches ONE deploy job. With involved services:

- **Fan-out**: target frames = the task's own frame + each involved frame with resolvable
  provisioning. One deploy job per frame, dispatched **sequentially in
  provider-before-consumer order** (reverse topological over the consumer→provider
  edges), parking `awaiting_job` between dispatches. `deployJobId` gains a frame
  discriminator; step state gains a per-frame map (`step.deployEnvs:
Record<frameId, { jobId, status }>`). All `ready` → the step finishes; any failure →
  the step fails (already-ready peer envs are left to expiry).
- **Cross-injection**: sequential provider-first ordering means each later provision can
  receive the already-ready peers. Extend `deployerProvisionArgs` — which already
  injects `frontendOrigins` — with `peerEnvUrls` (comma-joined `slug=url` pairs) for
  `{{input.*}}` manifest templating. **Documented limitation**: a provider that needs its
  consumer's URL (a cyclic env dependency) is out of scope for the first cut — no
  reconfigure pass.
- **Tester**: `testerInfraSpec` gains `peerEnvironments: Record<title, url>` beside
  `environmentUrl`, resolved by reusing `indexLiveServiceEnvUrls(handles,
involvedFrameIds)` (`frontend-infra.logic.ts`) verbatim — it is already generic over
  frame-id sets.
- **The one real storage gap**: `supersedePriorEnvironment` is keyed per task `blockId`,
  so N provisions for one task would supersede each other. It must become per
  `(blockId, frameId)`. Teardown is otherwise unchanged (expiry + the run-terminal
  cleanup keyed by `executionId` already cover N records).

## Phase 3 — multi-repo coding (designed, not yet implemented)

### Why sibling checkouts in one container

One container job clones ALL involved repos as sibling checkouts under a shared workspace
root; the harness pushes the same-named work branch and opens **one PR per repo that
actually changed**. Chosen because:

- The agent needs **full cross-repo context** to make a CONSISTENT contract change — the
  provider API and the consumer call site in one reasoning pass.
- **One PR per repo** keeps CI, review, and merge per-repo, matching how the repos are
  owned and protected.

Rejected alternatives:

- _Read-only peer checkouts_: the agent can see but not fix the consumer side, so
  cross-repo changes ship broken halves.
- _Coordinated multi-job_ (one container per repo): no shared context — each agent is
  blind to the other repo — plus a distributed-coordination problem for zero benefit.

### Mechanics

- **Resolver**: a new `resolveRepoTargets(workspaceId, blockId) → RepoTarget[]` beside
  the singular `resolveRepoTarget` — PRIMARY (the existing own-service walk) first, then
  one entry per involved frame, **deduped by repo** (two frames in one monorepo → one
  checkout with both `serviceDirectory`s noted). Every single-repo path keeps the
  singular resolver. An involved frame with no linked repo is skipped for coding — it can
  still provision an env (record this asymmetry).
- **Job body**: `AgentJob` gains `peerRepos?: PeerRepoSpec[]` (`{ repo, ghToken?, branch,
newBranch?, pr?, serviceDirectory? }`). A per-repo token is optional (defaults to the
  job's token — a workspace has one GitHub installation today), but the wire shape is
  ready for GitLab parity / multi-installation.
- **Workspace layout**: primary at `<workspaceRoot>/<primary.name>`, peers as siblings
  (owner-prefixed on a name collision); the agent's cwd is the workspace root. The
  layout is told to the agent twice: a generated "Multi-repo workspace" prompt section
  (which repo is primary; each peer's role from its connection `description`) and the
  global `~/.pi/agent/AGENTS.md` written outside the checkouts.
- **Push/PR fan-out**: the SAME branch name `cat-factory/<blockId>` in every repo;
  commit/push/PR only for DIRTY repos; `noChangesIsError` applies to the union. The
  `git.ts` helpers gain an explicit `dir` parameter.
- **Result / PR tracking**: keep `block.pullRequest` **singular** (the primary repo's PR)
  and add `block.peerPullRequests` + `AgentRunResult.peerPullRequests`
  (`{ repo, frameId?, ref: PullRequestRef }[]`). Chosen on caller count, not
  backwards compatibility: every single-repo reader (CI/mergeability/merger providers,
  issue writeback, the board PR chip) stays untouched, and the few multi-repo-aware
  phase-4 paths read a contracts helper `allPullRequests(block)`.
- **Image**: any harness `src/**` change bumps `@cat-factory/executor-harness` + the
  three pinned tags per the CLAUDE.md image rules.

## Phase 4 — gates + merger generalization (designed, not yet implemented)

- **CI gate**: the probe aggregates check runs across the primary + peer PRs
  (`step.gate.headShas: Record<repoFullName, sha>` replaces the single `headSha` on
  multi-repo blocks). All green → pass; any pending → pending; any failure → fail,
  listing the red repos. The **`ci-fixer` helper runs in the same sibling-checkout
  container** (job body with `peerRepos`, prompt naming the failing repos) — a
  cross-repo contract break is exactly the failure a single-repo fixer cannot fix. One
  fixer attempt covers all failing repos; the `ciMaxAttempts` budget is unchanged.
- **Conflicts gate**: mergeability probed per PR. The `conflict-resolver` stays
  SINGLE-repo (a git conflict is per-repo textual), dispatched at the first conflicted
  repo per attempt.
- **Merger**: ONE assessment over the **combined diff** (the merger container clones the
  sibling workspace; a cross-repo change's risk is a property of the whole), then
  **all-green-then-merge-all**: verify every PR is still mergeable, merge sequentially in
  provider-before-consumer order (deterministic fallback inside cycles: primary first,
  then frame-id order), deleting each work branch. The task is `done` only when ALL PRs
  merged. A mid-sequence failure leaves the block `blocked` with a notification
  enumerating merged vs unmerged PRs — **accepted non-atomicity** (cross-repo merges
  cannot be atomic); the human finishes or reverts by hand.
