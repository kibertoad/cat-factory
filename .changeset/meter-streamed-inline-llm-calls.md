---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/conformance': minor
---

Meter a streamed inline LLM call rather than refuse to make one

The LiteLLM gateway lane, added in this same change, is what found this: LiteLLM forwards an
upstream's usage chunk only when the client sends `stream_options: { include_usage: true }`, and
`openAiCompatibleResolver` never set the SDK's `includeUsage`. Every streamed call through an
OpenAI-compatible provider (both operator-hosted gateways, plus qwen / deepseek / moonshot / xai
and the Cloudflare REST resolver) would therefore have arrived with no counts and been booked at
zero tokens, which downstream is the same absence as a step that spent nothing. The option is now
set once, in the resolver, and is inert on a buffered call: the SDK only emits `stream_options`
from `doStream`, which is why nothing short of a real gateway could tell the two settings apart.

The other half was that no inline caller could stream at all. `InstrumentedModelProvider.wrapStream`
threw, deliberately, because a streamed call would otherwise have passed the wrap and reached no
sink; the refusal named the two things a streaming caller had to build first. Both are built here.
`wrapStream` folds a stream's parts into the shape a buffered reply already has, so `readUsage`,
`readFinishReason`, `readOutputText` and the gateway-attribution reader parse a stream through the
SAME code that parses a generate result rather than a second implementation that could disagree
with it. Every exit settles the row exactly once: the stream ending, the caller abandoning it (the
tokens were spent regardless, and the row names the cancellation rather than letting it read as a
model failure), an error part mid-flight, and a stream that never opens.

`InlineLlmCall.streaming` is a new REQUIRED field, so the flag is the producer's answer instead of
the constant `false` the recorder used to write. That is a breaking change to an internal port with
one first-party producer per runtime; the conformance suite now records one streamed row, since
every fixture writing `false` would let a store that flattened the flag round-trip clean. The
subscription-CLI inline model files its rows as streamed too, which is what the container half of
that same producer (`makeHarnessCallRecorder`) has always called them.
