---
---

test: improve test-double fidelity (no published-code change).

- orchestration: the review services' inline LLM is now faked with `MockLanguageModelV3`
  (`ai/test`) over the injected `ModelProvider` instead of `vi.mock('ai')`, exercising the
  real `generateText` call path and dropping the coupling to the SDK's export shape.
- integrations / server / observability-langfuse: the ad-hoc `fetch` stubs that returned
  hand-built (often non-real) responses now intercept the real global `fetch` with undici's
  `MockAgent` (Slack, runner-pool, Jira diagnose, web-search upstreams, work-branch REST,
  Langfuse ingestion), so tests run against real `Request`/`Response` semantics.

Deliberately left as-is: the narrow `FetchLike` DI seams (a deliberate DOM-free design),
`localModelUrl` (asserts the client-side `redirect: 'manual'` option, which a wire-level
interceptor can't observe), and the local-runtime GitHub tests (lateral / integration
passthrough).
