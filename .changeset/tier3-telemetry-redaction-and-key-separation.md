---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/integrations': patch
---

Secret-handling hardening:

- **LLM telemetry** (`LlmObservabilityService`) now scrubs credential shapes from the
  prompt/response/reasoning bodies AND the `errorMessage` with a shared `redactSecrets`
  (promoted to `@cat-factory/kernel`, reused by the provisioning-log path) BEFORE anything is
  stored or fanned out to an external trace sink (Langfuse). `errorMessage` is kept as
  diagnostic metadata even when bodies are dropped and is fanned out ungated, so it is
  scrubbed too (an upstream 4xx/5xx string can echo an auth header). Prompt/response/reasoning
  body capture is additionally gated on the per-workspace `storeAgentContext` toggle (numeric
  telemetry is always recorded). Also fixed a latent O(n²) regex backtrack in the URL-userinfo
  redaction rule that a large prompt could trigger.
- **Signed tokens** (`HmacSigner`) now derive an independent HKDF-SHA256 subkey per audience
  (`session`/`oauth-state`/`llm-proxy`/`ws`/`machine`), so a token class is cryptographically
  isolated rather than sharing one raw HMAC key. Key derivation is bounded to that fixed
  audience set — `verify` selects the key from the token's attacker-controlled claimed `aud`
  before the MAC check, so an unrecognised (or absent) audience falls back to the raw-secret
  base key rather than deriving+caching a fresh subkey, preventing an unbounded key-cache /
  per-request-HKDF DoS from a flood of junk-audience tokens. Breaking: any tokens signed before
  this change no longer verify (pre-1.0, no migration — clients re-authenticate).
