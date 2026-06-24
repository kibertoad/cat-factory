---
'@cat-factory/contracts': minor
'@cat-factory/local-server': minor
---

Make the **native environment-adapter** path first-class, so a deployment can inject a
hand-written `EnvironmentProvider` (e.g. a Kargo adapter) instead of the generic
manifest-driven `HttpEnvironmentProvider` — with per-workspace config and the supported
local-mode entry point.

- **Manifest `providerConfig` bag** (`@cat-factory/contracts`): `environmentManifestSchema`
  gains an optional, opaque `providerConfig: Record<string, unknown>`. The generic
  `HttpEnvironmentProvider` ignores it; a native adapter reads + validates it off the
  per-call `manifest`. Because an injected provider is a deployment-wide singleton, the
  per-workspace connection's manifest is its only per-workspace config carrier — so a
  single deployment can now target a different native project (Kargo project, link key,
  status map, …) per workspace. It rides inside the existing `manifest_json` JSON column on
  both runtimes — no migration, automatic D1 ⇄ Drizzle parity. **Not** covered by the
  manifest URL/SSRF checks (which only guard `baseUrl`/`tokenUrl`); an adapter that reads a
  URL from `providerConfig` must guard it itself.
- **`startLocal({ environmentProvider })`** (`@cat-factory/local-server`): the local-mode
  entry point gains an `environmentProvider` seam (and a `host` option, matching `start()`),
  threaded through `buildLocalContainer` → `buildNodeContainer`. A local deployment can now
  wire a native provider through the supported entry point — keeping local mode's boot
  preflight (orphan reaping, PAT/auth warnings) and differentiators — instead of bypassing
  `startLocal()` and re-implementing the preflight. `buildContainer` is intentionally not
  exposed (overriding it would discard local mode's differentiators).
- New `backend/docs/native-environment-adapter.md` documents the injection contract, the
  env-port-vs-runner-port boundary, teardown/TTL idempotency, the `@cat-factory/kernel`
  adapter dependency, and a reference `KargoEnvironmentProvider` sketch.

No backwards-incompatible changes: every addition is optional and defaults to today's
behaviour.
