---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/caching': minor
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

The initiator's declarations are read on EVERY dispatch, because the winning model is not known
until the shared resolver has walked its sources, so the read goes through a new `AppCaches`
slice keyed on the user (the endpoint write paths invalidate it). Without that, a deployment with no
local runners at all still paid a query per step, and a mothership-mode node an extra
`/internal/persistence` round trip per step.

Delivery still joins the HARNESS's answer first, and that is what decides where this lands today: a
local ref names no harness, so a container dispatch runs it on Pi, whose `HARNESS_IMAGE_INPUT` entry
is `false` and refuses without consulting the ref. The modality is therefore acted on by the inline
path, and the container path becomes a reader the day an image-carrying harness serves a local model,
which is a one-line table edit rather than new plumbing. It is resolved for every path regardless,
because the winning model is not known until the shared resolver has walked its sources.

`contextTokens` is deliberately NOT declared for a local model, though the same shape could carry it.
The window a runner serves is a fact about its config rather than about the weights (Ollama's
`num_ctx` default sits far below what a 128K-window model can do), nothing enforces it for a local
ref, and stating a number the runner silently ignores would be worse than stating none. The
truncation trap that follows from that is now written down in `backend/docs/model-support.md`.

**Internal break:** the endpoint row's enabled-model list changes from `string[]` to a declaration
array. A row written before this loses its entries on read: bare strings are dropped rather than
coerced, so the break cannot arrive as a model id of `[object Object]`. The endpoint reports the
discard (`unreadableModels`) and the panel names it per runner, because a shortened list on its own
reads exactly like a runner nobody ever enabled a model on and only one of those is fixed by
re-ticking. The fix is to re-tick the models in "My local runners", which rewrites the whole blob.
