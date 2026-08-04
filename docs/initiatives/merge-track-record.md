# Initiative: merge track record (reviewer effort, change class, per-class auto-merge rules)

Status: **complete**. The committed scope below landed in one change. Per CLAUDE.md this tracker
should be converted to a numbered ADR under [`backend/docs/adr/`](../../backend/docs/adr/) and
deleted once the deferrals below are settled (see "Deliberately deferred").
Owner: platform / merge lifecycle

## Goal & rationale

The merge decision today runs entirely on the `merger` agent's **self-assessment**: it scores the
diff (complexity / risk / impact), `MergeResolver.resolveMergerStep` compares those scores against
the task's resolved merge-threshold preset (`RiskPolicy`), and either merges via the
`PullRequestMerger` port or raises a `merge_review` notification.

Two signals are missing that would let the policy stand on accumulated **human evidence** instead
of the agent's word:

1. **Reviewer effort evaporates at merge time.** When a human acts on a `merge_review` /
   `pipeline_complete` card (or merges the PR directly on the provider), nothing records how much
   review the PR actually needed. "Zero blocking comments" vs "real rework" is the ground truth the
   auto-merge thresholds are meant to approximate.
2. **Runs are not classified by WHAT KIND of change they made.** The preset ceilings apply
   uniformly, so a workspace cannot express "auto-merge dependency bumps and docs, always review
   schema changes".

End state: every merge decision leaves behind a record of `(change class, merger scores, reviewer
effort tag, decision)`; per-class rollups are queryable as SQL aggregates; and merge presets carry
per-class auto-merge rules a workspace widens as the per-class track record earns it.

## The change-class union and its precedence rules

The union lives in `@cat-factory/contracts` (`src/mergeTrackRecord.ts`) so the frontend, the preset
shape, and the rollups share one source of truth. The pure classifier + the rank table live in
`@cat-factory/kernel` (`src/domain/change-class.ts`): pure logic, no ports.

| Class        | Rank | What matches                                                               |
| ------------ | ---: | -------------------------------------------------------------------------- |
| `docs`       |    0 | Markdown/text, `docs/`, `README`/`LICENSE`/`CHANGELOG`, i18n catalogs      |
| `test`       |    1 | `*.test.*` / `*.spec.*`, `test/`/`tests/`/`__tests__/`, fixtures, e2e spec |
| `dependency` |    2 | Lockfiles + dependency manifests (`package.json`, `Cargo.toml`, …)         |
| `config`     |    3 | CI workflows, linter/formatter/tsconfig, Dockerfiles, IaC manifests        |
| `source`     |    4 | Anything else: application/library source code                             |
| `schema`     |    5 | DB migrations + schema definition files                                    |
| `unknown`    |   -1 | No changed-file list available (no VCS client wired, or an empty diff)     |

**Precedence for a mixed diff: the HIGHEST-RANKED class present wins.** A diff touching
`package.json` + `src/foo.ts` classifies as `source`; a diff touching a migration + docs classifies
as `schema`. This is deliberate and is what makes a per-class rule safe by construction: an "always
auto-merge `dependency`" rule can only ever fire on a diff that contains **nothing riskier than** a
dependency change. It also means no `mixed` member is needed: the dominant risk is exactly what
the policy needs to key on, and the record additionally stores `changedFileCount` for context.

`unknown` is a first-class outcome, not an error: it is what a classification with no VCS client
wired (tests, an unconfigured workspace) produces. **`unknown` never matches a per-class rule**,
neither `always` nor `never`, so an unclassifiable diff always falls back to the score thresholds.
That invariant is why a classification failure can never widen the policy.

## Reviewer effort tag

`ReviewEffort` = `none` | `minor` | `major` (`none` = zero blocking comments). Nullable everywhere:
an untagged merge is recorded with a null tag and nothing downstream breaks on nulls.

Capture points:

- **`POST /notifications/:id/act`** for `merge_review` / `pipeline_complete` takes an optional
  `reviewEffort` in its body. The SPA card renders three chips (one tap, not a form) with a default
  preselected from whether the run's `pr-reviewer` step recorded findings that drove rework
  (`step.prReview`): `none` when it did not, `minor` when it did.
- **The inspector's merge control** (`TaskExecution.vue` / the run banner's merge button) carries
  the same chips and posts the same tag through `POST /merge-track-records/:id/effort`.
- **An external merge** (a human merged on GitHub/GitLab, bypassing cat-factory) is detected from
  the existing `pull_request` webhook ingest and raises a lightweight, dismissible
  `merge_tag_request` notification. Best-effort, never blocking.

### External-merge detection design

The webhook already projects `pull_request` deliveries (`WebhookService.handle` →
`pullRequestProjectionRepository.upsertMany`). We add a best-effort observer seam
(`WebhookServiceDependencies.externalMergeObserver`) invoked when the delivery is a **merged**
PR close.

The observer resolves the run **through the track record itself**, not through the block: the
merger step already wrote a `pending_review` record stamped with `repoId` + `prNumber`, so
`MergeTrackRecordRepository.getByPullRequest(workspaceId, repoId, prNumber)` is the whole lookup.
This deliberately avoids adding a `findByPullRequestUrl` port method to `BlockRepository` (blocks
store the PR as a JSON column, so that would be an unindexed scan) and it scopes the feature
correctly: we only care about external merges of PRs **cat-factory opened and was waiting on**.

## The preset reshape (a flagged breaking change)

`RiskPolicy` gains a **required** `classRules: MergeClassRules` field, a partial map from change
class to one of:

- `thresholds` (the default, and what an absent entry means): compare the merger scores against the
  preset ceilings, exactly as today.
- `always`: auto-merge regardless of the scores.
- `never`: always route to human review.

Precedence in `resolveMergerStep`, most-significant first:

1. `autoMergeEnabled: false`: the master switch. "Manual review only" stays manual; a class rule
   can **never** override it.
2. The class rule for the run's resolved class (skipped entirely when the class is `unknown`).
   `never` → review (`reason: 'class_requires_review'`). `always` → merge
   (`reason: 'class_auto_merge'`), bypassing both the score comparison **and** the
   rationale-credibility backstop: an explicit operator policy keyed on a _deterministic backend_
   classification outranks the agent's self-report.
3. The existing credibility + threshold comparison.

Two rungs were added above this ladder later, keyed on WHO started the run rather than on what the
change is: a role-scoped narrowing of the class rule, and a sandboxed run mode that merges nothing.
Both are in [ADR 0037](../../backend/docs/adr/0037-role-scoped-merge-policy.md), which is the authority on
the composed precedence.

Backwards compatibility is a non-goal (see CLAUDE.md), so the wire type gains the field as
**required** rather than optional-with-a-shim; persisted rows get `'{}'` from the column default and
resolve to "use the thresholds" for every class. Flagged in the changeset as a breaking wire change.

## The track record

One row per merge decision in `merge_track_records` (D1 ⇄ Drizzle parity), written **best-effort**
off the merge path: a classification or record-write failure is swallowed and logged, never
propagated, so **merges never fail or block due to this feature**.

Row identity is **deterministic** (`mtr_<executionId>`, or `mtr_ext_<repoId>_<prNumber>` for a
record born from an external merge with no run), and creation is `ON CONFLICT DO NOTHING`
(first-write-wins, mirroring `LlmCallMetricRepository.record`) so the durable driver's replays
cannot duplicate or clobber a row. The effort tag and the terminal decision arrive later as an
`UPDATE`.

Decisions: `pending_review` (recorded at the merger step when the PR was routed to a human) →
`auto_merged` | `human_merged` | `external_merged` | `rejected` (the human dismissed the review
card rather than merging).

Rollups are a **single** SQL aggregate per workspace (`GROUP BY change_class` with conditional
`SUM`s for each decision and each effort level), so the preset editor loads every class's stats in
one round-trip, never one query per class and never rows reduced in JS.

## Per-item status

| Item                                                                              | Status | PR  |
| --------------------------------------------------------------------------------- | ------ | --- |
| Contracts: change class, effort, record, class rules, rollup, routes              | done   | -   |
| Kernel: pure classifier + rank table + rule resolution; repository port           | done   | -   |
| Kernel: `classRules` on the `RiskPolicy` seeds                                    | done   | -   |
| Orchestration: `MergeTrackRecordService`; `MergeResolver` class-rule resolution   | done   | -   |
| Orchestration: human-merge / rejection / external-merge recording                 | done   | -   |
| Server: rollup + effort-tag controller; act-body effort plumbing                  | done   | -   |
| Integrations: external-merge webhook observer seam                                | done   | -   |
| Cloudflare: D1 repo + migration + wiring                                          | done   | -   |
| Node: Drizzle schema + repo + migration + wiring (schema.ts split first)          | done   | -   |
| Conformance: classify → merge → tag → rollup on both facades, + class-rule cases  | done   | -   |
| Frontend: preset editor per-class rules + track record; effort chips on the cards | done   | -   |
| Docs sweep + changeset                                                            | done   | -   |

## Conventions & gotchas carried between iterations

- **Provider-neutral vocabulary only.** The record's repo identity is `repoId` + `provider`
  (`VcsRepoRef`/`VcsProvider`), never `githubId`/`installationId`. Classification reads the changed
  files through `RepoFiles.listChangedFiles`, which `vcsBackedGitHubClient` already serves for
  GitLab, so the feature works identically on a GitLab deployment with no extra code.
- **No harness change, no image bump.** Classification is deterministic backend TypeScript over one
  VCS call. Whether the merger's assessment should later _refine_ the class is deliberately
  deferred: the merger sees the diff, but making it authoritative would put a non-deterministic
  input in front of a policy gate, and would need an image bump to change. Revisit only if the
  path-based rules prove insufficient in practice.
- **`unknown` must stay inert.** Any future class-rule surface must keep `unknown` unmatched, or a
  transient VCS outage silently changes merge policy.
- **The `merger` step resolver owns terminal status** (`ownsTerminalStatus`), so the record write
  belongs _inside_ `MergeResolver`, after the decision is known, not in a later interceptor that a
  partial multi-repo merge would skip.
- **`schema.ts` was at its ratchet.** Adding the Drizzle table meant splitting the Node schema
  first: the VCS/projection tables moved to `src/db/tables/vcs.ts` and `schema.ts` re-exports them,
  and the ratchet was lowered to match (never raised).

## Deliberately deferred

Named here so a later reader knows these were choices, not oversights:

- **The merger's assessment does not refine the class.** Evaluated and rejected for v1 (see the
  gotcha above): a non-deterministic input in front of a policy gate, changeable only via an image
  bump. The path rules are the source of truth until they demonstrably fall short.
- **Per-repo classification on a multi-repo task.** A record is scoped to the run's PRIMARY repo, so
  a cross-repo task classifies on its own-service PR. The peer PRs' diffs are not folded in; a
  per-repo record set is the natural follow-up if multi-repo tasks become common.
- **No time-windowed or per-author rollups.** The aggregate is all-time per class. A "last 30 days"
  cut is one more `WHERE created_at >=` in the same single query when someone wants it.
- **No automatic rule widening.** The rollups are surfaced next to the rules so a human decides;
  nothing proposes or applies a rule change on its own. That is deliberate: the whole point is that
  a policy change stays an explicit operator act.
- **The reviewer-effort tag is not fed back into the score thresholds.** It is recorded evidence, not
  a control input. Closing that loop (e.g. suggesting a ceiling from the tagged history) is a
  separate design question.
