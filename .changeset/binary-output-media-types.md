---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Let a binary-output step require exact FORMATS, not only content types, and check them at admission, in the brief, and against what the run delivered.

`stepOptions.binaryOutput.modalities` is the right grain for `image` — PNG versus WebP is a genre question and belongs in a prompt — and the wrong one for `3d`, where the container IS the compatibility contract. GLB, USDZ and FBX are all `3d` and none substitutes for another: a Godot importer takes the first, a RealityKit pipeline the second, an art pipeline the third. A step whose mesh must load in the game could therefore be admitted against an integration that cannot emit a loadable container, with the failure arriving at the end of a paid run as an asset nobody can open — which reads as a bad generation rather than as a selection nothing checked. `binaryOutput.mediaTypes` closes that at the level where the wrong answer is a file the consumer silently cannot use.

Every declared entry is REQUIRED, not any-of. A step delivering a GLB for the engine and an FBX an artist can open in Blender declares both and both are checked. An "any of these will do" reading was rejected because the agent is what names the container on the vendor call, and a requirement that leaves it a choice hands that decision to the party with the least basis for making it.

A format is never translated into a modality, in either direction. `modalityOfMediaType` recognises only the formats the platform happens to know, so inference would make the strength of a requirement depend on our vocabulary — a step spelled with a brand-new container would silently lose the coarse check its neighbour keeps. Matching is exact after ONE shared reduction: both declarations come through `mediaTypeSchema`, and a settled artifact's `contentType` (the model's own prose) goes through the newly exported `normalizeMediaType`, never a second lowercasing. No synonyms are mapped, deliberately — a matcher that accepted a near-neighbour would admit a GLB where an OBJ was required.

The coverage rule has THREE outcomes rather than two, and the third is what keeps this honest. A generator declaring no `mediaTypes` has said "only my modality is known" — a documented state, not an empty answer — so a requirement it cannot be judged against is UNVERIFIABLE (`binaryFormatCoverage`): the run is ADMITTED and the gap is stated instead, to the agent in its brief and to whoever composes the step in the picker. Refusing there would punish the honest declaration and break every integration that has not pinned its formats down; calling it covered would be the mirror mistake, a clean bill of health nobody issued on the surface that decides whether a run may start. It is the admission-side twin of `generatorsUnverified`. With nothing selected there is nobody to be silent, so a format requirement is uncovered outright and refuses under a new `media_type_uncovered` issue.

The brief states the required formats as exact strings to request and refuses substitution in words, because the agent is the party that chooses `target_formats`; the report surface adds the one judgement admission could not make, comparing what was required against the content types the run actually declared (`undeliveredMediaTypes`), derived in code and only where there are artifacts to compare against. The picker takes the requirement as free text with the selection's declared formats offered as a hint — a control offering only what the selection declares could never express the requirement whose violation this exists to catch.

Also: `application/x-blender` now classifies as `3d`, alongside the OBJ and STL legacy types, since a `.blend` file is what a 3D deliverable looks like when the consumer is an artist rather than an engine. And `HttpBinaryGeneratorSource` now holds a served view to carrying `mediaTypes`, because it is a field admission DECIDES on: an absent one would reach the coverage rule as a crash instead of the one `UnavailableError` every route to "we do not know what is registered" ends at.
