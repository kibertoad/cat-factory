---
'@cat-factory/worker': patch
---

Fix Workers AI in-process streaming duplicating every output token.

For a streamed completion served via the `AI` binding, the adapter accumulated text
from `streamText`'s `result.textStream`, whose deltas arrived doubled for some models
(observed on the `@cf/qwen/qwen3-*` reasoning family): the streamed reply came back
with every token repeated (`serviceservice…`), which broke every downstream JSON
parse (the requirements / blueprint / merger agents). Telemetry confirmed the model
generated the tokens once (`completion_tokens` was a single copy) — the duplication
happened during streamed-delta assembly, not generation.

The in-process path now builds both the buffered and the streamed response from one
non-streaming `generateText` (`doGenerate`) call, replaying it as a single SSE content
chunk when the caller asked to stream. This sidesteps the streamed-delta assembly
entirely, so it's robust regardless of which layer (AI SDK / provider / binding)
introduced the doubling. Pi (and any OpenAI client) concatenates deltas, so a one-shot
content chunk is equivalent; the harness reads the final message and live progress
comes from the todo tool, not token streaming.
