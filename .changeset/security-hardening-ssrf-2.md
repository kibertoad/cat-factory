---
'@cat-factory/agents': patch
'@cat-factory/server': patch
'@cat-factory/integrations': patch
'@cat-factory/contracts': patch
---

Security hardening (round 2, SSRF/injection batch):

- **SEC-2** — the inline model-provider path now routes local-runner endpoints through the
  redirect-revalidating `fetchLocalRunner` (an optional `fetch` on `openAiCompatibleResolver`), so
  an inline LLM call can't be 302'd to the cloud-metadata endpoint. Matches the proxy path.
- **SEC-7** — the Confluence document provider reuses the shared `safeFetch`, which strips the
  Basic-auth header and body on a cross-origin redirect (the local copy that kept them is removed).
- **SEC-9** — explicit `bodyLimit` backstops on the unauthenticated `/github/webhooks` and
  `/vcs/:provider/webhooks` raw-body reads (25 MB) and the LLM proxy `/v1/chat/completions` route
  (32 MB), so an anonymous/session caller can't pin memory before the HMAC/session check.
- **SEC-10** — the initiative `slug` wire field is constrained to a lower-kebab grammar, so no
  `/`/`..` segment can reshape a committed `docs/initiatives/<slug>/…` path.
- **`/vcs` fail-closed fix** — `/vcs` is added to the auth gate's `PUBLIC_PREFIXES`, so the
  provider-neutral VCS webhook receiver is reachable on an auth-enabled deployment (it verifies its
  own per-provider signature/token, like `/github`).
