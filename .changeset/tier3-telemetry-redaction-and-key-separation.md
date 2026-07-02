---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/integrations': patch
---

Secret-handling hardening:

- **LLM telemetry** (`LlmObservabilityService`) now scrubs credential shapes from the
  prompt/response/reasoning bodies with a shared `redactSecrets` (promoted to
  `@cat-factory/kernel`, reused by the provisioning-log path) BEFORE anything is stored or
  fanned out to an external trace sink (Langfuse). Prompt/response/reasoning body capture is
  additionally gated on the per-workspace `storeAgentContext` toggle (numeric telemetry is
  always recorded). Also fixed a latent O(n²) regex backtrack in the URL-userinfo redaction
  rule that a large prompt could trigger.
- **Signed tokens** (`HmacSigner`) now derive an independent HKDF-SHA256 subkey per audience
  (`session`/`oauth-state`/`llm-proxy`/`ws`/`machine`), so a token class is cryptographically
  isolated rather than sharing one raw HMAC key. Breaking: any tokens signed before this
  change no longer verify (pre-1.0, no migration — clients re-authenticate).
