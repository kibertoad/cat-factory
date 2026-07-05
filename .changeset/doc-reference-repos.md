---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/executor-harness': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

feat(docs): attach read-only reference repositories to a document-authoring task

Let a document-type task carry a list of **reference repositories** the `doc-writer` agent clones
READ-ONLY while it drafts, so it can reuse existing solutions in those repos as a reference. The
writer is already containerized (`container-coding`), so no interim step is needed — the reference
repos become extra sibling checkouts it may read but can never write to.

- **Read-only by construction.** Reference repos flow through a NEW `referenceRepos` block field,
  separate from the writable `involvedServiceIds`/`fanOutMultiRepo` path. The harness job spec
  carries no branch/PR fields for a reference, the multi-repo coder clones it at its base branch
  with no work branch, and the push phase skips it — three independent layers, so a reference repo
  is structurally impossible to push to. Its clone URL is host-allowlisted like every other repo.
- **Any accessible repo, by name fragment.** A reference need not be a board service or in the
  workspace's synced projection: the inspector picker reuses the SAME server-side, debounced repo
  search as the add-service modal (extracted into a shared `useRepoSearch` composable), so any repo
  the GitHub App installation or the signed-in user's PAT can reach can be attached.
- **Symmetric persistence.** New `reference_repos` JSON column on `blocks`, mirrored across the D1
  and Drizzle stores with a cross-runtime conformance round-trip assertion.

Bumps `@cat-factory/executor-harness` (new read-only reference-leg support in the coding harness) —
the runner image tag pins and `RECOMMENDED_HARNESS_IMAGE` are bumped in lockstep.
