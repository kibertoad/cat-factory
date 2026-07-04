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
| `resolveRepoTargets` (plural) beside the singular resolver; dedupe by repo; monorepo `serviceDirectory`s | todo   |
| `AgentJob.peerRepos` + sibling-checkout workspace layout in the harness (image bump)                     | todo   |
| Push/PR fan-out: same `cat-factory/<blockId>` branch per repo, PR only for dirty repos                   | todo   |
| `AgentRunResult.peerPullRequests` + `block.peerPullRequests` + `allPullRequests(block)` helper           | todo   |
| Multi-repo prompt section (peer roles from connection descriptions) + `AGENTS.md` note                   | todo   |
| Conformance: two-repo coding run records both PRs on both runtimes                                       | todo   |

### Phase 4 — gates + merger generalization (design in the doc, §Phase 4)

| Item                                                                                                   | Status |
| ------------------------------------------------------------------------------------------------------ | ------ |
| CI gate aggregates across PRs (`step.gate.headShas` map); fixer runs in the sibling-checkout container | todo   |
| Conflicts gate per PR; single-repo conflict-resolver dispatched at the first conflicted repo           | todo   |
| Merger: combined-diff assessment + all-green-then-merge-all in provider-first order                    | todo   |
| Mid-sequence merge failure → block `blocked` + notification enumerating merged vs unmerged             | todo   |
| Conformance: multi-PR gate + merge-all behaviour on both runtimes                                      | todo   |

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
