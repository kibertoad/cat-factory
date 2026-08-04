---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/app': minor
---

Name the overlap when a binary-output step selects two integrations that produce the same content
type. `binaryModalityOverlaps` (contracts) reports which content types have more than one producer
in a step's selection; the agent's brief states it after the per-integration entries and asks for
the declaration's `generator` field so the choice is on the record, and the pipeline builder states
it beside the step's prompt as an advisory. It refuses nothing and ranks nothing: a modality stops
deciding at the second producer of it, and which one is right is a fact about the work.
