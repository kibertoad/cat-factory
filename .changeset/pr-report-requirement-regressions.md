---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
---

Count and flag REGRESSIONS on the PR verification report's requirement → evidence section
(service-acceptance-criteria, slice 5).

The in-repo spec's implementation-state axis makes exactly one fact derivable, and nothing
derived it: a `not_met` against an `established` requirement is behaviour the service was
OBSERVED to honour and no longer does, while a `not_met` against an `aspirational` one is work
that is not finished yet. That sentence was written into the build prompt, the tester prompt, the
group-markdown render and `CLAUDE.md` — four places, all prose, addressed mostly at a model. On
the PR report both readings arrived as the same `❌ not met` cell inside the same `notMet` tally,
so a reviewer had to cross-reference two columns of a table that may be capped.

- `prReportRequirementsSchema` gains `regressions`, counted over the whole spec before any cap.
  It is a SUBSET of `notMet` (not a fourth tally), so the counts still sum to `total`.
  `PR_VERIFICATION_REPORT_VERSION` → 3.
- The rendered section leads with a regression call-out when there is one and marks those rows
  `🔴 **regression**`, distinct from a plain `not met`, so the call-out points at identifiable
  rows.
- The requirement table's cap is no longer a plain prefix. Rows are emitted in spec order, so a
  prefix cap could drop the one row a reviewer must not miss purely by where its feature sorts.
  Regressions are now selected ahead of every other row, the remaining budget is filled in spec
  order, and the selection is restored to spec order to render; the truncation note says the kept
  rows are not a prefix. Priority is not a guarantee — a spec with more regressions than the row
  budget still loses some, so the note reports how many FIT and the call-out says the table shows
  fewer than it counts.

This is evidence, not policy: nothing gates a merge or fails a run on it.
