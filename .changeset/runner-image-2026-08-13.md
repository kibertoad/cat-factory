---
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': patch
---

Rebuild the executor image on Claude Code 2.1.229. Pi (0.84.1), Codex (0.147.0) and the Pi
todo/web-tools extensions (2.4.0) are already on their newest release, and the shared
`node:26-trixie-slim` base still resolves to the digest the image is pinned to, so Claude Code is
the only moving part.

The image tag is bumped to `cat-factory-executor:1.113.0` across the wrangler config, the publish
script and `RECOMMENDED_HARNESS_IMAGE`, since republishing over a live tag does not roll a
deployment out. The deploy image is unchanged and keeps `0.2.13`.
