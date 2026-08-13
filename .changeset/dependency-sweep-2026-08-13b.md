---
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/consensus': patch
'@cat-factory/gatekeeper-worker': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/worker': patch
---

Refresh every direct and transitive dependency to the newest version the 24h
`minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with (`ai@7.0.64`,
`@ai-sdk/openai@4.0.41`, `@ai-sdk/amazon-bedrock@5.0.55`). The Cloudflare toolchain moves
together again: `wrangler@4.122.0` and `@cloudflare/vitest-pool-workers@0.21.2`, whose bundled
wrangler tracks it. `@aws-sdk/client-s3` goes to 3.1109.0 and the SPA's store engine to
`pinia@4.0.3` / `@pinia/nuxt@1.0.2`.

`capnweb` moves 0.10.0 to 0.11.0 in the Gatekeeper Worker. The release is additive (stubs as
stream chunks, exact ArrayBuffer/DataView serialization, URL over RPC) and touches neither
`RpcTarget` nor `newWorkersRpcResponse`, the only two symbols we import. Its 0.11.1 patch, which
enforces an ASCII-only dist bundle so a consumer's `btoa()` cannot choke on the runtime, missed
the release-age window by two hours and is the first thing the next sweep should pick up.

Held back deliberately: `@changesets/cli` 3.0.0 and, in the frontend, `typescript` 7 (Nuxt 4.5.2
itself depends on `typescript@6.0.3`). No `minimumReleaseAgeExclude` entries were added: every
version above already satisfies the gate.
