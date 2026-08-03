---
'@cat-factory/worker': minor
---

Add `createWorker(options?)`, the Cloudflare facade's installation seam. Every app-owned registry
was newed at module scope and none of the instances was exported, so a deployment that re-exports
the default handler could register nothing — the asymmetry with `start({ … })` / `startLocal({ … })`
on the other two facades. `createWorker` owns the whole boot sequence (log level, once-guarded
registration validation over the injected registries, `scheduled`/`queue`), so extending is one
line: `export default createWorker({ overrides: { foundationalServiceRegistry } })`.
`export default createWorker()` keeps every existing deployment byte-for-byte unchanged.
