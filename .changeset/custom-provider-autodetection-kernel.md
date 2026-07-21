---
'@cat-factory/kernel': minor
---

Add reusable checkout-free **manifest-probe** primitives for custom test-infrastructure
provider autodetection (`src/shared/manifest-probe.logic.ts`): `matchManifestSignature`
(declarative multi-file signatures), `firstPresent`/`allPresent`/`anyPresent`, `readYamlDoc`/
`readYamlDocs`, `listFiles`, all over the shared `BudgetedRepoScanner`, plus the `detect()`
authoring types `CustomManifestDetectionContext` / `CustomManifestDetection`. Adds `yaml` as a
runtime dependency for the YAML helpers.
