---
'@cat-factory/gates': patch
---

Close the give-up prose around an absent summary

Every gate's give-up path splices a `summary` into a sentence, and that summary is routinely
absent. Written inline as `${summary ?? ''}` the separator sits on both sides of nothing, and the
`.trim()` guarding it binds to the last template literal of the concatenation: it silently does
nothing whenever the hole is mid-sentence. The CI, doc-quality and post-release-health cards all
reached a human with a doubled space in the body asking them to intervene. The fragments are now
composed through `joinSentences`, so an absent one drops out wherever it sits.

The rest of the change is tests and mutation-score floors across `@cat-factory/gates`,
`@cat-factory/spend` and `@cat-factory/kernel`. Those ship no source change, so they take no
version bump.
