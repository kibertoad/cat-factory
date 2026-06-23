---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Capture the model's reasoning / "thinking" trace in LLM observability. A reasoning
model (e.g. `@cf/moonshotai/kimi-k2.7-code`) can spend its whole output budget in a
separate reasoning channel and return an empty completion — previously those output
tokens were unaccounted for (`response_text` empty, no trace), which made an empty
spec-writer/blueprint failure undiagnosable. The LLM proxy now records `reasoningText`
alongside `responseText`: the Workers AI in-process path reads it from the AI SDK
(`generateText`'s `reasoningText`), and the OpenAI-compatible buffered + streamed paths
read `reasoning_content` / `reasoning`. Stored in the new `reasoning_text` column
(`llm_call_metrics`, D1 migration `0002_llm_reasoning_text` ⇄ Drizzle), surfaced in the
metrics export and the Observability panel, and used as the Langfuse trace output when
the response text is empty.

Breaking: the `llm_call_metrics` table gains a non-null `reasoning_text` column (old
rows default to `''`).
