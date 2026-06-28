---
'@cat-factory/app': patch
---

Merge the two Integrations-Hub infrastructure entries (self-hosted runner pool + ephemeral
environment provider) into one tabbed **Infrastructure** window, and add a full in-app
**manifest editor** so any manifest-driven provider (incl. a runner pool) can be registered,
tested, and rotated entirely in-app instead of dead-ending on a "use the API" disclaimer.

- One hub row ("Infrastructure", `i-lucide-server-cog`) showing a combined per-concern
  summary, opening a single modal with **Container agents** / **Test environments** tabs
  (each gated on its own availability probe). The local-mode delegation toggles move to the
  top of the window (cross-cutting), removing the old runner-pool ⇄ env cross-link hint.
- New `ProviderManifestEditor.vue`: a JSON manifest editor + write-only secrets sub-form,
  validated client-side against the SAME Valibot wire contract the backend enforces
  (`RunnerPoolManifest` / `EnvironmentManifest`), seeded from the saved manifest or a static
  per-kind starter. Native (flat-form) providers are unchanged. The server stays
  authoritative (register re-validates).
- Adds `data-testid`s on the tabs + editor for e2e coverage. Pure frontend; no backend or
  store changes (`register`/`test` already carry a raw `{ manifest, secrets }`).
