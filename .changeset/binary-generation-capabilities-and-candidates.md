---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Binary generation: provider capability traits, per-step generation options, and side-by-side
candidate comparison.

A registered generative integration now declares `capabilities` (reference images, masked or
instruction editing, negative prompt, seed, aspect ratio, batching, upscaling, transparent
background, seamless tiling), and a binary-output step declares the generation options each of
those unlocks. An option nothing selected supports refuses the run at admission with
`binary_output_generator_invalid` / `capability_unsupported`; an option nothing has DECLARED either
way is admitted and stated as unverifiable, so every integration registered before this axis
existed keeps working unchanged.

A step may also declare a `comparison`: it generates a candidate per subject from every selected
integration, parks, and a human keeps one (or several under distinct ids) before the step re-runs
to deliver exactly those.

Internal shape change: the engine's park-window verbs moved from sixteen `ExecutionService`
delegates onto one `executionService.decisions` surface.
