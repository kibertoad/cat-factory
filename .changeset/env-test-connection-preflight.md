---
'@cat-factory/orchestration': patch
---

Pre-flight the provider connection in the environment self-test. Before creating the throwaway branch, `startTest` now runs the resolved provider's connection probe (`testProvisioning` → the provider's `testConnection`); a bad connection — a rejected token, or a wrong project/endpoint — is rejected up front as a 409 (`env_test_connection_failed`) carrying the provider's own message, instead of failing opaquely mid-provision after a branch has already been created and has to be torn back down. Providers without a `testConnection` (or `infraless`) are unaffected (the probe returns null).
