---
'@cat-factory/contracts': minor
---

Extend `provisioningRecommendationSchema` with additive `custom`-only fields for custom-provider
autodetection: `customConfigSeed` (extracted config to prefill), `secondaryManifestPaths` (the
other files a multi-file signature matched), and `detectedManifestTypeCandidates` (the arbitration
result). Documents `prefer: 'custom'` without a `manifestId` as the arbitration trigger.
