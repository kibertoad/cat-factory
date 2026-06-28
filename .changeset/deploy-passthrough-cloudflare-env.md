---
---

ci: pass `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` through Turbo's strict env mode for the `deploy` task, so `turbo run deploy` no longer fails with "necessary to set a CLOUDFLARE_API_TOKEN" — the backend Worker deploy is the only Cloudflare step routed through Turbo, and strict env mode was stripping the credentials the CI step exports.
