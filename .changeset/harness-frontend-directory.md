---
'@cat-factory/executor-harness': patch
---

Frontend UI-test stand-up: honor an optional `directory` on the frontend infra spec so a monorepo
frontend builds/serves from its subdirectory (install, build, serve, and WireMock run there;
`outputDir`/`mockMappingsPath` are relative to it). Bumps the runner image tag.
