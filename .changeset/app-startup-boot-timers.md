---
'@cat-factory/node-server': minor
'@cat-factory/local-server': patch
---

Add boot-phase timers to the backend startup path (app-startup initiative, item 1). `bootServer`
now brackets each phase (config, migrate, pg-boss start, container build, bus, worker registration,
listen) with `performance.now()` and logs one structured `cat-factory node server ready in N ms`
line with the per-phase breakdown; local mode times its own preflights (container-runtime probe,
GitHub PAT probe) the same way. New `startBootClock` helper is exported from `@cat-factory/node-server`.
Pure instrumentation — no behavioural change.
