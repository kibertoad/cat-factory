---
'@cat-factory/contracts': patch
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
---

Frontend↔backend ephemeral-stack wiring (slice 6a of the frontend-preview initiative):

- **Reverse CORS origin injection.** A `deployer` step now passes `inputs.frontendOrigins` — the
  comma-joined browser origins (`http://localhost:<servePort>`) of every `frontend` frame that
  binds the service being provisioned (the reverse of the frontend's `backendBindings`). A
  backend manifest folds it into its CORS allow-list via `{{input.frontendOrigins}}` (HTTP-manifest
  provider) or `{{frontendOrigins}}` (Kubernetes native adapter, flat scope), so an ephemeral
  frontend can reach an ephemeral backend. Derivation is automatic (`frontendOriginsForService`,
  a single workspace block-list read — no N+1); the CORS env-var mapping stays operator-authored,
  and the backend must be re-provisioned to pick up a newly-linked frontend.
- **Binding-resolution correctness.** `resolveFrontendBindings` now dedupes a repeated `envVar`
  deterministically (last non-empty binding wins, matching the injected env map) instead of leaving
  it to insertion order. New `duplicateBindingEnvVars` predicate (contracts) surfaces the collision
  for the inspector + run-start notes (a follow-up slice); it is advisory, not a schema reject
  (bindings persist per-blur with an allowed empty `envVar`).

Runtime-neutral (all facades). The inspector visibility panel + run-detail projection (6b) and the
deterministic local preview host port (6c) are tracked follow-ups in
`docs/initiatives/frontend-preview-ui-testing.md`.
