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

`binaryFormatCoverage` moves to contracts beside it, for the same reason, and the SPA's
hand-written copy of that rule is deleted. BREAKING for anything importing it from
`@cat-factory/kernel`, which no longer re-exports it (nor `BinaryFormatCoverage`): import both from
`@cat-factory/contracts`. Behaviour is unchanged, except that an absent `mediaTypes` and an empty
one are now one state in both places, which is what each side already meant by it.

A step's selection also resolves a repeated generator id ONCE, on both surfaces. Nothing refused
such a selection, and a repeat rendered that integration's whole entry twice in the agent's brief.
