---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/executor-harness': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Fix the review, testing and merge gates so findings are acted on and a bad merge
can't slip through.

- Pipeline order: the `reviewer` companion now runs IMMEDIATELY after `coder`
  (before `blueprints`/`mocker`/`tester`), in `pl_full`, `pl_fullstack`,
  `pl_dep_update` and `pl_tech_debt`, so review + rework happen on freshly written
  code before the map/test tail. The positional `gates` arrays are unchanged (the
  gated slots all sit before `coder`).
- First review batch always loops back: the FIRST companion pass (reviewer /
  spec-companion / architect-companion) that raises any comments now loops the
  producer back regardless of rating; the configured threshold only governs the
  SECOND pass onward. The same rule applies to the `tester` gate: the first testing
  round hands ANY finding (even a low/medium concern) to the fixer, and low/medium
  concerns become advisory only from the second round.
- Review results no longer silently pass: a companion whose own JSON verdict can't
  be parsed (e.g. a truncated reply) used to default to a perfect 100% pass and drop
  the real review. The engine now retries once and, if the verdict still won't parse,
  fails the run for human attention. Companions also get a larger output-token budget
  so the verdict JSON doesn't truncate in the first place.
- Merger can't auto-merge a PR it didn't examine: the merger harness now does a full
  clone (so `git diff origin/<base>...HEAD` actually works — the shallow single-branch
  clone was the root cause of "branch not found" and bogus 0/0/0 scores) and, when it
  still can't examine a real diff, returns a conservative assessment that routes to
  human review. The engine additionally only auto-merges a credible, explained
  (non-empty rationale) within-threshold assessment.

Bumps the executor-harness image tag (merger clone change) to 1.4.0.
