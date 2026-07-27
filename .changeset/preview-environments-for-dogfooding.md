---
'@cat-factory/app': patch
---

Treat an EMPTY `apiBase` as the same-origin deployment topology when deriving the WebSocket
origin.

`useWorkspaceStream` mapped `apiBase` http→ws directly, which assumed an absolute origin: with
an empty `apiBase` (one reverse proxy serving the SPA and the API together) it produced a
relative socket URL. That topology is not hypothetical — it is the only one a preview stack can
use, because the SPA's API base is baked in at build time while the stack's host port is only
assigned at `up` time. The new pure `utils/apiOrigin.ts` (`apiOriginFor` / `wsOriginFor`)
substitutes the page's own origin when `apiBase` is blank; an absolute `apiBase` is unchanged,
so split-origin deployments behave exactly as before.

Ships alongside the new `deploy/preview` per-PR test environments for this repository (see
`docs/dogfooding.md`), which are what needed it.
