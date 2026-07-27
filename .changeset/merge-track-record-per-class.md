---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/conformance': patch
---

Merge track record: reviewer-effort tags, deterministic change-class classification, and
per-class auto-merge rules on merge presets.

The merge decision no longer runs purely on the `merger` agent's self-assessment. Every merge
decision now persists one row in a new `merge_track_records` table (full D1 ⇄ Drizzle parity)
carrying the run's **change class**, the merger's scores, the outcome (`pending_review` →
`auto_merged` / `human_merged` / `external_merged` / `rejected`), and a nullable **reviewer-effort
tag** (`none` / `minor` / `major`). Per-class rollups are single SQL aggregates behind
`GET /workspaces/:ws/merge-track-records/rollups`.

- **Classification** is deterministic backend TypeScript over ONE VCS call (`RepoFiles.listChangedFiles`
  → the pure `classifyChangedFiles`), so it needs no harness change or runner-image bump and works
  identically on a GitLab deployment. Classes are risk-ranked (`docs` < `test` < `dependency` <
  `config` < `source` < `schema`) and a mixed diff takes the highest-ranked class present. An
  unreadable diff yields `unknown`, which never matches a per-class rule.
- **Per-class rules** on a merge preset: `always` auto-merge, `never` auto-merge, or fall back to the
  score ceilings — resolved with `autoMergeEnabled: false` as the master switch a rule can never
  override.
- **Effort capture** at the existing decision points: `POST /notifications/:id/act` takes an optional
  `reviewEffort` (one-tap confirm-and-tag, preselected from whether the run's PR review recorded
  findings), `POST /workspaces/:ws/merge-track-records/:id/effort` tags out of band, and a PR merged
  directly on the provider is detected from the webhook ingest and nudged with a dismissible
  `merge_tag_request` card. Tagging is never mandatory: an untagged merge records a null tag.
- Classification and record writes are **best-effort side channels** — a failure in any part of this
  feature can never fail or block a merge.

A merge decision's record carries the run's **provider-neutral repo identity** (`repoId` +
`provider`), captured from the run-repo resolution the classification already performs. That is what
makes a record attributable: external-merge detection can only look a record up by
`(repoId, prNumber)`, since a webhook delivery knows nothing else about the run.

**BREAKING (backend API):** `RepoTarget` (`@cat-factory/server`) and `RunRepoContext`
(`@cat-factory/kernel`) gain a required `repoId` plus an optional `provider`, in the neutral
`VcsRepoRef` vocabulary. Both are produced in exactly one place each, so a deployment that builds
its own `ResolveRepoTarget` / `ResolveRunRepoContext` must supply the id; the compiler points at
every site.

A contract route whose request body is ALL-optional now mounts the new `optionalJsonBody`
middleware (`@cat-factory/server`). A declared `requestBodySchema` otherwise makes the transport
REQUIRE a body — the validator reads `c.req.json()` before the schema is consulted — so a route that
merely gained an optional field would start rejecting the body-less calls it had always accepted.
`POST /blocks/:blockId/merge` and `POST /notifications/:id/act` keep working with no body at all.

**BREAKING (wire shape):** `RiskPolicy` gains a required `classRules` field (a partial map from
change class to `thresholds` / `always` / `never`). Per the pre-1.0 policy there is no dual-read
shim: persisted rows take the `'{}'` column default, which resolves to "use the score ceilings" for
every class — i.e. byte-for-byte the previous behaviour — but any external consumer of the preset
wire shape must account for the new field. The built-in preset seeds bump to version 4, so existing
workspaces are offered a reseed. `notificationTypeSchema` also gains `merge_tag_request`, and
`MergeDecision.reason` gains `class_auto_merge` / `class_requires_review`; both are closed unions a
consumer may be switching on exhaustively.
