---
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

Fix local-mode CORS + two SPA regressions

- **local-server:** default `ENVIRONMENT=local` in `applyLocalDefaults`, and pass the
  localized env (not the raw one) into `start()`. The shared app's CORS middleware reads
  `ENVIRONMENT` / `CORS_ALLOWED_ORIGINS` directly off the env, and the raw env was being
  passed through, so the server default-DENIED CORS and the SPA on `:3000` failed with
  "can't reach backend" until an operator hand-set `CORS_ALLOWED_ORIGINS`. Local mode now
  reflects the SPA origin out of the box (auth is a bearer header, credentials mode off).
- **app:** import the `CreateInitiativeModal` component in `index.vue` — it was referenced
  in the template but never imported, so Vue logged "Failed to resolve component".
- **app:** stop sending an empty `?kind=` query when describing an infra provider without a
  concrete backend kind. The empty string was read as a real (unknown) backend kind and
  rejected with 422; the request now omits the param so the server falls back to the
  workspace's stored/default kind.
