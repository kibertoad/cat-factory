---
'@cat-factory/cli': minor
---

`cat-factory k3s` now hands the provisioned cluster off to the SPA (guided-setup slice 3).
After provisioning, it builds the `local-k3s` infra-handler registration input
(`buildK3sHandler`) — apiserver URL, skip-TLS, the `cf-env-{{pullNumber}}` namespace + the
`{{branch}}.127.0.0.1.nip.io` ingress defaults, and the minted ServiceAccount token in the
write-only secret bundle — and opens the SPA's Local k3s connect form **pre-filled** via a
deep-link (`buildK3sSetupUrl`). The link carries only the non-secret fields (the token is a
secret — it would leak into browser history/logs — so it is printed once for the user to
paste); the user then runs Test → Save, reusing the existing connectivity probe. New
`--app-url` flag (default `http://localhost:3000`) picks the SPA base; the browser open is
skipped under `--no-open` or non-interactive `--yes`. A hands-free `--register` flag that
POSTs the handler to the local API is documented as a follow-up. The handler shape is
validated against the real `registerEnvironmentHandlerSchema` in tests, so the CLI keeps its
single `@clack/prompts` runtime dependency (contracts is a devDependency only).
