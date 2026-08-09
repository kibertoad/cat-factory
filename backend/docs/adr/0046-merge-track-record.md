# ADR 0046: Merge track record (change class, reviewer effort, per-class auto-merge rules)

- **Status:** Accepted (implemented)
- **Date:** 2026-08-07
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/orchestration`, `@cat-factory/integrations`, `@cat-factory/server`, both runtime
  facades) + the SPA (`@cat-factory/app`)

Supersedes the `merge-track-record` initiative tracker, whose committed scope is complete.
Composed with [ADR 0037](./0037-role-scoped-merge-policy.md) and
[ADR 0039](./0039-role-scoped-submission-allowlists.md), which add rungs above this ADR's class
rule keyed on WHO started the run; together those two are the authority on the composed
precedence.

## Context

The merge decision ran entirely on the `merger` agent's self-assessment: it scores the diff
(complexity / risk / impact), `MergeResolver.resolveMergerStep` compares those scores against the
task's resolved merge-threshold preset (`RiskPolicy`), and either merges through the
`PullRequestMerger` port or raises a `merge_review` notification.

Two signals were missing that would let the policy stand on accumulated human evidence instead of
the agent's word:

1. **Reviewer effort evaporated at merge time.** When a human acted on a `merge_review` /
   `pipeline_complete` card, or merged the PR directly on the provider, nothing recorded how much
   review the PR actually needed. "Zero blocking comments" versus "real rework" is the ground truth
   the auto-merge thresholds are meant to approximate.
2. **Runs were not classified by WHAT KIND of change they made.** The preset ceilings applied
   uniformly, so a workspace could not express "auto-merge dependency bumps and docs, always review
   schema changes".

## Decision

Every merge decision leaves behind a record of `(change class, merger scores, reviewer effort tag,
decision)`; per-class rollups are queryable as SQL aggregates; and merge presets carry per-class
auto-merge rules a workspace widens as the per-class track record earns it.

### The change-class union and its precedence

The union lives in `@cat-factory/contracts` (`src/mergeTrackRecord.ts`) so the frontend, the preset
shape and the rollups share one source of truth. The pure classifier and the rank table live in
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

**For a mixed diff the HIGHEST-RANKED class present wins.** A diff touching `package.json` plus
`src/foo.ts` classifies as `source`; a diff touching a migration plus docs classifies as `schema`.
That is what makes a per-class rule safe by construction: an "always auto-merge `dependency`" rule
can only fire on a diff containing nothing riskier than a dependency change. It also means no
`mixed` member is needed, since the dominant risk is exactly what the policy keys on; the record
stores `changedFileCount` for context.

`unknown` is a first-class outcome, not an error: it is what a classification with no VCS client
wired produces. **`unknown` never matches a per-class rule**, neither `always` nor `never`, so an
unclassifiable diff always falls back to the score thresholds. That invariant is why a
classification failure can never widen the policy.

### Reviewer effort tag

`ReviewEffort` = `none` | `minor` | `major` (`none` = zero blocking comments), nullable everywhere:
an untagged merge records a null tag and nothing downstream breaks on nulls. Capture points:

- **`POST /notifications/:id/act`** for `merge_review` / `pipeline_complete` takes an optional
  `reviewEffort`. The SPA card renders three chips (one tap, not a form) with a default preselected
  from whether the run's `pr-reviewer` step recorded findings that drove rework (`step.prReview`).
- **The inspector's merge control** carries the same chips and posts through
  `POST /merge-track-records/:id/effort`.
- **An external merge** (a human merged on the provider, bypassing cat-factory) is detected from the
  existing `pull_request` webhook ingest and raises a dismissible `merge_tag_request` notification,
  best-effort and never blocking.

External-merge detection hangs off a best-effort observer seam
(`WebhookServiceDependencies.externalMergeObserver`) invoked when a delivery is a merged PR close.
The observer resolves the run **through the track record itself**: the merger step already wrote a
`pending_review` record stamped with `repoId` and `prNumber`, so
`MergeTrackRecordRepository.getByPullRequest(workspaceId, repoId, prNumber)` is the whole lookup.
This avoids a `findByPullRequestUrl` port method on `BlockRepository` (blocks store the PR as a JSON
column, so that would be an unindexed scan) and scopes the feature correctly: only external merges
of PRs cat-factory opened and was waiting on.

### The preset reshape

`RiskPolicy` gains a required `classRules: MergeClassRules` field, a partial map from change class
to `thresholds` (the default, and what an absent entry means), `always` (auto-merge regardless of
scores) or `never` (always route to human review). Precedence in `resolveMergerStep`,
most-significant first:

1. `autoMergeEnabled: false`, the master switch. "Manual review only" stays manual; a class rule can
   never override it.
2. The class rule for the run's resolved class, skipped entirely when the class is `unknown`.
   `never` routes to review (`reason: 'class_requires_review'`); `always` merges
   (`reason: 'class_auto_merge'`), bypassing both the score comparison and the
   rationale-credibility backstop, because an explicit operator policy keyed on a deterministic
   backend classification outranks the agent's self-report.
3. The existing credibility and threshold comparison.

Backwards compatibility for internals is a non-goal, so the wire type gains the field as required
rather than optional-with-a-shim; persisted rows get `'{}'` from the column default and resolve to
"use the thresholds" for every class.

### The record

One row per merge decision in `merge_track_records` (D1 ⇄ Drizzle parity), written best-effort off
the merge path: a classification or record-write failure is swallowed and logged, never propagated,
so merges never fail or block because of this feature.

Row identity is deterministic (`mtr_<executionId>`, or `mtr_ext_<repoId>_<prNumber>` for a record
born from an external merge with no run) and creation is `ON CONFLICT DO NOTHING`
(first-write-wins, mirroring `LlmCallMetricRepository.record`), so the durable driver's replays
cannot duplicate or clobber a row. The effort tag and the terminal decision arrive later as an
`UPDATE`. Decisions run `pending_review` → `auto_merged` | `human_merged` | `external_merged` |
`rejected`.

Rollups are a single SQL aggregate per workspace (`GROUP BY change_class` with conditional `SUM`s
per decision and per effort level), so the preset editor loads every class's stats in one
round-trip.

## Rationale

- **A deterministic backend classification is the only input safe to put in front of a policy
  gate.** The merger sees the diff and could refine the class, but making its judgement
  authoritative would put a non-deterministic input in front of the gate and would need a runner
  image bump to change. Path rules stay the source of truth until they demonstrably fall short.
- **Provider-neutral by construction.** The record's repo identity is `repoId` plus `provider`
  (`VcsRepoRef` / `VcsProvider`), never `githubId` / `installationId`, and classification reads the
  changed files through `RepoFiles.listChangedFiles`, which `vcsBackedGitHubClient` already serves
  for GitLab. The feature works identically on a GitLab deployment with no extra code.
- **The write belongs inside `MergeResolver`.** The `merger` step resolver owns terminal status
  (`ownsTerminalStatus`), so the record write goes there, after the decision is known, rather than
  in a later interceptor a partial multi-repo merge would skip.

## Consequences

- **`unknown` must stay inert.** Any future class-rule surface has to keep `unknown` unmatched, or a
  transient VCS outage silently changes merge policy.
- **The Node schema split is permanent.** Adding the Drizzle table meant splitting `schema.ts`
  first: the VCS and projection tables moved to `src/db/tables/vcs.ts` and `schema.ts` re-exports
  them, with the size ratchet lowered to match.
- **The merger's assessment does not refine the class.** Evaluated and rejected; revisit only if the
  path rules prove insufficient in practice.
- **A record is scoped to the run's PRIMARY repo.** A cross-repo task classifies on its own-service
  PR and the peer PRs' diffs are not folded in. A per-repo record set is the natural follow-up if
  multi-repo tasks become common.
- **Rollups are all-time per class.** No time-windowed or per-author cut; a "last 30 days" view is
  one more `WHERE created_at >=` in the same single query.
- **Nothing widens a rule automatically.** The rollups sit next to the rules so a human decides. A
  policy change stays an explicit operator act.
- **The reviewer-effort tag is recorded evidence, not a control input.** Feeding it back into the
  score thresholds (suggesting a ceiling from tagged history) is a separate design question.
- **The loop reaches `/api/v1` in spec 1.32.0** (`GET /runs/:runId/merge-record`,
  `GET|POST /merge-records/:recordId[/effort]`, `GET /merge-records/rollups`), so an integration
  that starts runs headlessly can also record and read the evidence they produce. Tagging is a
  `write` key, one rung below the `admin` a merge needs: the pull request has already landed, so a
  tag merges nothing. The public `act` route stays body-LESS, which is why the app's one-tap
  confirm-and-tag has no headless equivalent: every SDK emitter renders a request body as a
  required positional parameter, so the field would break `act(id)` in four published clients.
  Reference: [`public-api.md`](../public-api.md#merge-evidence-apiv1merge-records).
