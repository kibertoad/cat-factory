---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/consensus': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/conformance': patch
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

A locally-run model can now be given a run's design renders. Its image support resolves in two
tiers: a table of recognised open-weights families (`KNOWN_LOCAL_MODELS`, so ticking Gemma 4 or Muse
Glimmer needs no second step), overridden by a per-model declaration on the user's own runner entry
for anything the table cannot know about.

The gap was structural rather than a missed case. `acceptsImages` is a per-FLAVOUR fact declared on
`MODEL_CATALOG`, and a local model has no catalog row: it lives on one person's machine, its id is
free text, and the OpenAI-compatible `/models` probe the panel discovers models with returns ids and
nothing else. So every local ref arrived with the modality absent and `resolveDesignImageDelivery`
answered `unknown_model_image_input` for all of them, forever. That reason exists precisely so this
would stay visible instead of reading as a text-only model, and the arrival of image-capable local
models is what turned it from a latent hole into a lost capability.

The declaration wins over the table on purpose: the person who pulled the weights is the one who
knows whether they are running a text-only quant, a fine-tune or a re-tagged copy. The table
therefore carries only families whose SILENCE costs a capability (every member is image-capable; a
text-only entry would behave identically to an absent one), and a family whose modality depends on
the size is left out rather than approximated, which is why Gemma 3 is absent while Gemma 4 is
present. It lives in `@cat-factory/contracts` because the settings panel labels its "not set" option
with what the table will do and the engine folds the same answer onto the dispatched ref.

`contextTokens` is deliberately NOT declared for a local model, though the same shape could carry it.
The window a runner serves is a fact about its config rather than about the weights (Ollama's
`num_ctx` default sits far below what a 128K-window model can do), nothing enforces it for a local
ref, and stating a number the runner silently ignores would be worse than stating none. The
truncation trap that follows from that is now written down in `backend/docs/model-support.md`.

**Internal break:** the endpoint row's enabled-model list changes from `string[]` to a declaration
array. A row written before this reads as a runner with nothing enabled (bare-string entries are
dropped rather than coerced, so the break arrives as an empty list the panel reports rather than as a
model id of `[object Object]`), and the fix is to re-tick the models in "My local runners".
