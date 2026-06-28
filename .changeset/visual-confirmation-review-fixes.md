---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Harden + complete the Visual Confirmation gate / binary-artifact storage after review.

- **Security (artifact serving):** the artifact upload + blob endpoints now pin the content
  type to a raster-image allow-list (`png`/`jpeg`/`webp`/`gif`, SVG/HTML rejected `415`) at the
  write boundary, and serve blobs with `X-Content-Type-Options: nosniff` + a clamped
  `Content-Type`/`Content-Disposition` — closing a stored-XSS vector where an attacker-controlled
  type could be served inline same-origin. Shared `imageArtifacts.ts` keeps the workspace upload
  and the in-container ingest paths consistent.
- **Configurable artifact retention (new):** a per-workspace `artifactRetentionDays` setting
  (default 14, bounded 1–3650), editable in the workspace settings panel. A daily Cloudflare cron
  / hourly Node timer sweep prunes each workspace's screenshots + reference images past its window
  — BOTH the metadata rows and the bytes (`BinaryArtifactStore.pruneOlderThan`), so the store no
  longer grows unbounded. Mirrored D1 ⇄ Drizzle (migration `0018` / a generated Drizzle migration)
  and asserted by the cross-runtime binary-artifacts conformance suite.
- **tester-ui ingest seam (backend half):** `ContainerAgentExecutor` injects an `artifactUpload`
  `{ url, token }` into the `tester-ui` job body, reusing the run's existing container session
  token + proxy base URL, and a new container-token-authed `POST ${proxyBaseUrl}/artifacts/ingest`
  route stores the bytes as a run-scoped `screenshot`. (The UI-tester image routing + harness env
  passthrough remain the deploy-time follow-up — see the handover doc.)
- **Gate UX:** a `request-fix` that can't dispatch (no PR branch / no async executor) now surfaces
  a reason + records a failed round instead of silently re-parking; after a fix the gate flags that
  the shown screenshots predate it (recapture to refresh); the unused `headSha` placeholder is
  dropped; and the gate window revokes its cached screenshot object URLs on unmount.
