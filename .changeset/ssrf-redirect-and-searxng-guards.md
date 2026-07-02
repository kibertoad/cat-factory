---
'@cat-factory/integrations': patch
'@cat-factory/server': patch
---

Harden three server-side SSRF surfaces:

- **Local-runner allow-list** no longer treats a DNS hostname that merely starts with `fc`/`fd`
  (e.g. `fc2.com`) as a private IPv6 ULA — the ULA/loopback tests are now gated behind an
  "is IPv6 literal" check and the classification reuses the vetted kernel `ip-host` primitives.
- **Runner-pool provider** (`HttpRunnerPoolProvider.execute`/`oauthToken`) and the shared
  `probeConnection` now follow redirects by hand and re-run the SSRF guard on every hop, so a
  permitted scheduler host can't 302 the secret-bearing dispatch body to an internal/metadata
  target. Factored the per-hop `safeFetch` + capped-read helpers into a shared module reused by
  the environment provider. `safeFetch` additionally drops the request body and strips
  credential headers (`authorization`/`cookie`/`proxy-authorization`) on any **cross-origin**
  redirect hop, so a permitted host also can't bounce the secrets to a _different_ public host
  (re-establishing the cross-origin credential stripping the platform `fetch` would have done,
  which the manual `redirect: 'manual'` follower had bypassed).
- **Account-configured SearXNG web-search URL** is now validated (public host, http/https, no
  private/internal/metadata target) both at the write boundary and with per-hop revalidation on
  fetch.
