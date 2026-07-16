---
'@cat-factory/node-server': patch
---

refactor(node): split the monolithic `repositories/drizzle.ts` into per-domain files

The ~5,000-line `repositories/drizzle.ts` (39 repository classes in one module) is broken
into per-domain files under `repositories/drizzle/` (`board`, `execution`, `accounts`,
`telemetry`, `settings`, `reviews`, `kaizen`, `initiatives`, `sandbox`, `connections`, plus
a shared helper), mirroring the Cloudflare D1 per-repository layout. `drizzle.ts` stays as a
thin barrel that assembles `CoreRepositories` and re-exports the directly-consumed classes,
so every importer is unchanged. Pure code movement — no schema or behavioural change.
