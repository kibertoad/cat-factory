---
'@cat-factory/server': minor
'@cat-factory/worker': patch
---

Move the application configuration type contract (`AppConfig` and every
sub-config interface) into `@cat-factory/server`. The config SHAPE is now shared
by every facade, while each runtime keeps its own loader that produces it (the
Worker's env-driven `loadConfig` is unchanged). This lets the shared HTTP layer
type `container.config` without depending on any runtime. Behaviour is unchanged.
