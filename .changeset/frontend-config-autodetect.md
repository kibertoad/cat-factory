---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Frontend-config inspector: add repo autodetection, a frontend-directory field, clearer serve-mode
help, and collapsible field groups.

- **Detect from repo**: a new deterministic, checkout-free detector proposes a frontend config
  (package manager from the lockfile, install command, build script + output dir from
  package.json/framework markers, serve mode/script, and backend-binding env-var names from dotenv
  examples). Exposed as `POST /workspaces/:ws/environments/detect-frontend-config`
  (`detectFrontendConfig` on the environments connection service) and surfaced in the panel as a
  non-binding preview the user reviews and applies (backend bindings are appended, never
  overwriting existing service links).
- **Frontend directory**: `FrontendConfig.directory` scopes a monorepo frontend's build/serve to a
  subdirectory (threaded into the harness job-body builder).
- **Serve mode**: replaced the single hint with per-mode descriptions and a note distinguishing it
  from the separate env-injection axis.
- **Grouping**: the panel's fields are now collapsible sections (Build / Serve / Mocking / Env
  injection / Backend bindings / Preview), collapsed by default.
