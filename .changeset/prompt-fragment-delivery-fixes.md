---
'@cat-factory/agents': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Fix five bugs in how best-practice prompt fragments are managed and applied:

- **Code-aware helper agents now receive the service fragments.** `ci-fixer`, `fixer`
  and `on-call` are dispatched off their HOSTING step (a `ci`/`post-release-health`
  gate, the tester, the human-test/visual-confirmation loops), and the fragment fold
  keyed off that step's kind — so the helpers never received the service's standards
  despite being marked `code-aware`. `AgentContextBuilder.buildContext` now takes an
  explicit `agentKind` override and every helper dispatch passes it; the on-call job
  body additionally folds the resolved fragments into its bespoke system prompt
  (previously bypassed). A stale `step.selectedFragmentIds` is also cleared when a
  re-dispatch resolves to nothing, so observability can't over-report.
- **Tier tombstones now stick on the run path.** `resolveBodiesForRun` used to fall
  back to the static pool for any id missing from the merged catalog — which is
  exactly what a tombstone does to a built-in, so suppressing a fragment a service
  had selected silently resurrected it. The fallback is gone; a missing id is dropped.
- **Deployment-registered fragments join the tenant catalog.** The library's built-in
  tier now reads the UNIVERSAL pool (shipped catalog + `registerPromptFragment`
  entries, lazily) instead of the raw shipped array, so a registered override of a
  built-in id actually reaches runs and the resolved catalog, and registered
  fragments can be tier-shadowed/tombstoned like any built-in.
- **Repo-source resync no longer mishandles renames and id edits.** The tombstone
  sweep is keyed by the fragment ids the current tree produces, not by stale paths:
  renaming a file that pins an explicit frontmatter `id` no longer tombstones the
  fragment the rename just updated, and changing a file's explicit `id` in place now
  retires the old id instead of leaving a live duplicate forever. The GitHub
  installation is also resolved once per sync instead of once per file, and the
  requirement writer's fragment grounding resolves through the merged tenant catalog
  when the library is wired.
- **The SPA pickers now offer the merged catalog.** The per-service / per-block /
  workspace-default fragment pickers loaded only the static built-in pool, so
  managed, repo-sourced and document-backed fragments could be authored but never
  attached (and a managed id set via API rendered no chip). The fragments store now
  loads the workspace's resolved catalog (falling back to the static pool when the
  library is off), invalidates on library edits, and unknown selected ids render as
  removable chips instead of disappearing.
