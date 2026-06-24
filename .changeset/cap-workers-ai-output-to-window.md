---
'@cat-factory/kernel': patch
'@cat-factory/server': patch
---

LLM proxy: cap a workers-ai call's `max_tokens` to the model's context window.

The proxy floors every workers-ai container call's output request to 32K
(`PI_MIN_OUTPUT_TOKENS`), assuming Workers AI clamps a too-large request to the
model's real max. It does not — a model whose TOTAL context window is also 32K
(e.g. `@cf/qwen/qwen3-30b-a3b-fp8`) rejects the WHOLE request (error 8007 →
HTTP 502) because the 32K output floor alone fills the window, leaving no room for
the prompt. Every blueprint/default-model step on that model 502'd on its first
call and the run failed with "the blueprint agent did not return a usable service
tree" (an empty completion).

The catalog already declares each model's window (`contextTokens`); the proxy now
consults it. New `contextWindowFor(ref)` in `@cat-factory/kernel` looks the window
up by provider + model, and the proxy caps the floored `max_tokens` so estimated
input (serialized prompt + tool definitions) plus output fits the window. The cap
only ever narrows the floor; a large-window model (kimi/glm at 256K) or one with no
declared window keeps the full 32K. No model change — small-window models now work
through the proxy instead of hard-failing.
