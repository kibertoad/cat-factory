# `@cat-factory/observability-langfuse` — opt-in Langfuse trace sink

A fetch-based `LlmTraceSink` that streams LLM generations (and container tool spans) to
Langfuse's ingestion API; runs unchanged on both the Cloudflare Worker (workerd) and Node
facades. **See [README.md](./README.md).**

**Entry:** `src/index.ts`.
