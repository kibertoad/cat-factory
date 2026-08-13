---
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': patch
---

Rebuild the executor image on Claude Code 2.1.231. Pi (0.84.1), Codex (0.147.0) and the Pi
todo/web-tools extensions (2.4.0) are already on their newest release, and `node:26-trixie-slim`
still resolves to the digest the image is pinned to, so Claude Code is again the only moving part.

This pin is taken at Claude Code's newest release rather than the newest one 24h past publication:
it ships several times a week and the harness tracks it closely, so holding it a day behind
routinely means shipping a known-fixed bug. The exemption covers this ARG alone, is re-made
explicitly on each bump, and does not extend to Pi, Codex or any workspace dependency, which stay
under the `minimumReleaseAge` gate. The Dockerfile says so beside the pin.

The image tag moves to `cat-factory-executor:1.119.0` across the wrangler config, the publish
script and `RECOMMENDED_HARNESS_IMAGE`, since republishing over a live tag does not roll a
deployment out. The deploy image is unchanged and keeps `0.2.13`.
