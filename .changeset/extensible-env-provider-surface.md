---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Widen the env-provisioning + runner-pool surface so an external orchestration adapter
(e.g. an in-house PR-environment platform) can be written on top of our ports and wired
into a stock facade build, without forking the facades.

- `EnvironmentProvider` provision requests now carry a typed `provisionContext`
  (branch / PR number+url / repo owner+name, derived from the block's PR ref) and the same
  values are flattened into `{{input.*}}` for the manifest path. The deployer step supplies
  it. A PR-environment provider needs the git ref + repo to target the right environment.
- New `UrlSafetyPolicy` (kernel) + `resolveUrlSafetyPolicy` (server): the env + runner-pool
  URL/host guard is now policy-driven. The default stays strict (https-only, no
  private/internal hosts); a TRUSTED operator can widen it per facade to reach an internal
  platform on a private/VPN host. The two integrations are scoped **independently** — each
  resolves its own policy from its own config slice, so widening one (`ENVIRONMENTS_*`) does
  not widen the other's (`RUNNERS_*`) SSRF guard. Config: `ENVIRONMENTS_ALLOW_URL_HOSTS` /
  `ENVIRONMENTS_ALLOW_HTTP_URLS` and `RUNNERS_ALLOW_URL_HOSTS` / `RUNNERS_ALLOW_HTTP_URLS`
  (Node env vars + the matching Worker `[vars]`).
- The Node facade's `buildNodeContainer` gains a documented `environmentProvider` seam (the
  Worker injects via `buildContainer`'s `overrides`); a custom adapter replaces the default
  manifest-driven `HttpEnvironmentProvider` while the env repos + secret cipher still wire
  from config. The local facade inherits the seam through `buildNodeContainer`.

No backwards-incompatible changes: every addition is optional and defaults to today's
behaviour.
