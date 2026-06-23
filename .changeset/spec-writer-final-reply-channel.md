---
'@cat-factory/server': patch
---

Spec-writer prompt: require the JSON spec in the final reply's visible content.

A spec-writer run on `@cf/moonshotai/kimi-k2.7-code` failed with "the requirements
agent did not return a usable specification: its final turn produced no text (an
empty completion)" even though the model produced a complete, valid spec. The whole
document landed in the model's reasoning channel and the assistant `content` channel
came back empty (telemetry: `finish_reason='stop'`, 6958 completion tokens, ~31k
chars of `reasoning_text`, zero `content`). The harness reads the document from the
content channel only, so the no-empty-outcome gate (`unusableFinalAnswerCause`)
correctly failed the run.

The gate stays — it converts a no-document outcome into a loud failure + retry
instead of laundering an empty spec downstream. The fix is in the prompt, which was
ambiguous in two ways a reasoning model can resolve wrongly: "you maintain the
specification committed to the repository" reads like a file-write job (the agent
has no write tools), and "respond with ONLY a JSON object" never said the JSON must
be the visible final reply. `SPEC_WRITER_SYSTEM_PROMPT` now states the agent has no
repository write access and must return the JSON as the visible text of its final
reply, not inside its private reasoning, and that an empty visible reply is a
failure even when the reasoning holds the document.
