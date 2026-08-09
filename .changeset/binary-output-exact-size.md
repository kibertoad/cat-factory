---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/app': minor
---

Let a binary-output step require an exact output size, gated by a capability that can refuse it.

`BinaryGenerationOptions` could state an aspect RATIO and not a SIZE, so for the deliverables where
the pixel dimensions are the requirement rather than a refinement of it (an inventory icon, a sprite
an engine slices, a texture an atlas packs) the most load-bearing fact about the artifact was the one
thing a step could not declare. It reached the agent as prose, and a step holding only a bucketed API
was admitted, generated at the nearest bucket, downscaled, and stored something every other check
passes and the consumer never uses.

`generation.outputSize` (`{ width, height }`) states it, gated by a new `exact-size` capability. The
existing `aspect-ratio` member is narrowed to what it can honestly carry: a ratio, or a fixed set of
size buckets. **A deployment registering an integration that takes a width and a height (Flux, Retro
Diffusion) must now declare `exact-size` beside `aspect-ratio`** to keep serving size-requiring
steps. The vocabulary is flat by design, so neither member implies the other, and the cost of missing
the declaration is a refusal that names the capability rather than a silent mis-render.

The platform deliberately does not gain a per-integration size table (it would go stale here while
the vendor changed it there, and it is the `resolutionRange` discriminator the design record already
refused), and it states no policy about resizing after generation. It checks that an integration can
be ASKED for a size, states the target in the brief, and requires that any substitution be reported.

`outputSize` is mutually exclusive with `aspectRatio` and `upscale`, refused at pipeline save: each
states the delivered dimensions a second time and can disagree, and resolving that by precedence
would leave the choice to the agent writing the vendor call.

The read-back closes the loop, because admission checks only what an integration can be asked for: a
declared artifact may carry `dimensions`, and the step's result window counts what came back at
another size, keeping artifacts that reported no dimensions on their own line rather than letting an
unmeasured one read as a delivered one.
