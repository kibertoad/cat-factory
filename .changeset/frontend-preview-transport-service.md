---
'@cat-factory/orchestration': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/integrations': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
---

Browsable frontend preview — transport dispatch + `PreviewService` + controller + stop (slice 5c of
the frontend-preview + in-context UI-testing initiative,
docs/initiatives/frontend-preview-ui-testing.md).

Wire the harness `preview` mode (slice 5b) end to end: a `frontend` frame can now be built and
served on a HOST-reachable URL for a browsable preview, and stopped again. New pieces:

- A new optional `PreviewTransport` kernel port — the per-runtime half that publishes a served
  app's port to an ephemeral host port and keeps the container alive past the build job. The local
  facade wires the real one over its Docker/Podman/OrbStack/Colima/Apple adapter (a second
  published port read back with `docker port` / the container IP); the Worker never wires it.
- A runtime-neutral `PreviewService` (start / get / stop) that persists the running preview like an
  ephemeral `environments` row keyed by the `frontend` frame (reusing the existing table + soft-delete
  stop path — no new migration), plus a `PreviewController` mounting
  `GET|POST|DELETE /workspaces/:ws/frames/:frameId/preview`, gated server-side on the
  `frontendPreview.supported` capability (503 on the Worker).
- The cross-runtime conformance suite drives the full start → serve → stop lifecycle on both Postgres
  runtimes with a fake transport, pinning the ephemeral-env-row persistence parity.

Notes:

- `frontendPreview.supported` now tracks whether a preview transport is actually wired: a stock Node
  build (runner pool, no host-port-publish primitive) advertises `false`, so the SPA never offers a
  Start button that would 503; local mode (and any facade injecting a `previewTransport`) advertises
  `true`.
- Preview rows share the `environments` table but carry a dedicated `preview` discriminator (outside
  `provisionTypeSchema`), so the environment subsystem filters them out of its generic listing +
  block-resolution paths — a preview never leaks into the deployer-env UI or tester env resolution.
- `PreviewService.get` re-polls a `ready` preview so a vanished/evicted container stops reporting a
  stale, unreachable URL (it flips to `failed`); a healthy preview whose URL merely can't be
  re-derived keeps its authoritative persisted URL.

Local/node differentiator; the SPA surface (the clickable URL + a stop button on the frame inspector)
lands in slice 5d. The harness is unchanged (no runner-image bump).
