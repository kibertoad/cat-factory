---
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
---

Local mode ships an on-by-default self-hosted SearXNG web-search upstream.

Web search for container agents is a backend proxy (`/v1/web-search/search`) that resolves its
upstream from the run's per-account settings — so local mode previously had no web search until a
developer hand-entered keys. This adds a **deployment-level trusted default upstream** the proxy
falls back to when the account has none, and wires a self-hosted SearXNG as that default in local
mode (on by default, disable with `LOCAL_WEB_SEARCH=off`).

- **server**: `SearxngWebSearchUpstream` gains a `trusted` flag that trusts only the deployment's
  own configured origin (its base URL — which may be loopback/LAN — and same-origin redirects)
  while a CROSS-origin redirect stays SSRF-guarded, so a trusted-but-compromised upstream can't
  pivot to an internal/metadata host; redirect/credential-stripping/byte-cap protection is
  unchanged. New `createDefaultWebSearchUpstream(...)` (trusted counterpart to
  `createWebSearchUpstream`). `ServerContainer` gains optional `defaultWebSearchUpstream`, which
  `WebSearchProxyController` uses as the fallback when the account resolves no upstream (the
  account path still wins and stays SSRF-guarded; neither ⇒ the unchanged empty-result degrade).
- **node-server & worker**: both facades build the default from `WEB_SEARCH_BRAVE_API_KEY` /
  `WEB_SEARCH_SEARXNG_URL` / `WEB_SEARCH_SEARXNG_API_KEY`, surface it on the container, and
  advertise Pi's `web_search` tool whenever a default exists (or the account has keys). A stock
  Node **or Cloudflare** deployment can now set a deployment-wide default (Brave or a public
  self-hosted SearXNG); each facade carries a proxy-fallback parity test.
- **local-server**: `applyLocalDefaults` points `WEB_SEARCH_SEARXNG_URL` at the local SearXNG
  (`http://localhost:8080`) unless `LOCAL_WEB_SEARCH=off`; the `deploy/local` docker-compose gains a
  pinned `searxng` service (behind a `web-search` profile) + a `settings.yml` enabling the JSON API.

The only Cloudflare-specific gap is the loopback-SearXNG story (no localhost container on workerd),
which is inherently local-only; the runtime-neutral Brave/public-SearXNG default is now symmetric.
