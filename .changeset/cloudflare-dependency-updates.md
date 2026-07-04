---
"@cat-factory/worker": patch
"@cat-factory/provider-cloudflare": patch
---

Update Cloudflare dependencies to the latest release-age-compliant versions:
`wrangler` 4.105.0 → 4.107.0, `@cloudflare/workers-types` 4.20260628.1 →
4.20260702.1, `@cloudflare/vitest-pool-workers` 0.16.20 → 0.18.0, and
`workers-ai-provider` 3.2.1 → 3.3.1 (still within the `ai@^6` / `@ai-sdk/*@^3`
peer range). `@cloudflare/containers` is already on the latest release (0.3.7).
