---
'@cat-factory/app': patch
---

Show the gate helper's working state on the board drill-down. The board task card's
pipeline mini-view (`TaskPipelineMini`) rendered a polling gate's surfaced subtasks (e.g.
the conflict resolver's "0/7" todos) but never the gate's companion node, so a gate
actively working its `ci-fixer` / `conflict-resolver` (or the Tester's `fixer`) read as a
frozen checklist. It now renders the same companion line the inspector and focus pipeline
already show — a spinning "Conflict Resolver · Running" — via the shared `gateCompanionFor`
helper.
