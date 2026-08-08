---
'@cat-factory/contracts': minor
'@cat-factory/app': minor
---

Pipeline builder: the purpose selector moves onto the palette's control row, beside the agent tier,
and narrows the catalog per purpose.

The two dials that decide what the palette offers now sit together above it, each stating what it is
holding back ("n hidden for this purpose" / "n hidden at this tier"). The purpose is still saved on
the pipeline, so nothing about the stored shape changes.

The filtering behind it splits into two predicates in `@cat-factory/contracts`.
`purposeSuggestsAgentCategory` is new and is what the palette OFFERS: a review pipeline reviews an
existing pull request, so the design kinds go; a planning pipeline writes no repo documentation and
opens no pull request, so the documentation and gate kinds go. `purposeAllowsAgentCategory` keeps its
current meaning and is what the builder will SAVE, so a stored pipeline never becomes unsaveable in
the editor it was built in because the relevance table gained an opinion it did not have when that
pipeline was built. Relevance is a subset of compatibility, asserted over the whole grid.

Both vocabularies are closed but persisted, so `@cat-factory/contracts` also gains the
schema-derived `isPipelinePurpose` and `isAgentCategory` guards. A `Pipeline.purpose` or a
registered kind's `presentation.category` outlives the build that wrote it, and both predicates now
narrow through them before indexing their table: an unrecognised value means this build has nothing
to narrow by, which is what an absent one already meant. The purpose control names such a value
instead of rendering a blank label.
