---
'@cat-factory/integrations': minor
---

Custom test-infrastructure providers can now define autodetection. A `custom` manifest type may
declare an optional `detect(ctx)` hook (`RegisteredCustomManifestType`) that recognizes the
provider from a repo's shape (multi-file signatures via the new kernel probe primitives), locates
its manifest, and extracts a config seed. `detectServiceProvisioning` runs the selected type's
hook, arbitrates across every registered type's hook when none is selected
(`detectCustomProviderAcrossTypes`), and falls back to custom arbitration as a last resort after
the kubernetes/compose sweep.
