---
'@cat-factory/server': patch
'@cat-factory/node-server': patch
---

Elaborate the two `REDIS_URL` failure modes (error-message initiative A7).

- **`ioredis` missing** (REDIS_URL set, optional dep not installed): both Node Redis consumers
  (real-time cross-node propagation and distributed cache invalidation) now throw the shared
  `missingIoredisProblem` — a `ConfigValidationError` naming `REDIS_URL`, the install-or-unset
  remedy, and the docs — instead of a bare `Error` deep in boot, so it lands on the misconfigured
  fallback screen. A `REDIS_URL` entry is added to the server `ENV_HELP` registry.
- **Bus unreachable** (REDIS_URL set, Redis down): a best-effort, timeout-bounded boot probe
  (`warnIfRedisUnreachable`, mirroring local mode's `probeGitHubPat`) now logs ONE elaborate,
  credential-free warning naming the host, the silent degradation, how to verify
  (`redis-cli -u <REDIS_URL> ping`), and the docs — instead of ioredis retrying silently while
  cross-node realtime and cache coherence are quietly degraded. Never blocks or crashes boot.
