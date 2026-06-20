---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': patch
---

Store LLM observability prompts as a delta instead of the full re-sent conversation.

A container agent re-sends its whole growing message history on every model call, so
storing each call's full prompt was hugely redundant — in a real 30-call run the
serialised prompts were ~21× larger than storing the conversation once. The
observability sink now stores only the messages a call APPENDED beyond
`promptPrefixCount`, with a `promptHash` of the full array so the next call can verify
it genuinely extends the previous one before its prefix is elided (a fresh
conversation on retry, or a context-compacted prompt, safely falls back to storing the
full array). The full prompt is rebuilt from the chain's deltas on export, and the
drill-down panel shows just the new messages per call (with an "N earlier omitted"
note) — less noise as well as far less storage.

`LlmCallMetric` gains `promptPrefixCount` + `promptHash`; `LlmCallMetricRepository`
gains `latestChainTip(...)`. D1 migration `0027` and a Drizzle migration add the two
columns to `llm_call_metrics`. The cross-runtime conformance suite asserts the delta
round-trip and chain-tip lookup against both real stores.
