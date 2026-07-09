---
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': minor
---

feat(local): fail loudly when the executor harness version doesn't match the backend

Add a version handshake so a stale or mismatched executor is surfaced clearly and early
instead of as a cryptic downstream error (the class of bug where a since-removed git flag
reappears in an old image and breaks every authenticated clone/push with `fatal: unable to
get password from user`).

- The harness now self-reports its version on `/health` (baked into the image as a file next
  to `dist/`, since the image ships no `package.json`; read from `package.json` in native/npm
  installs).
- Both local runner transports (per-run/pooled container and native host process) verify the
  running harness against the version this backend build is matched to
  (`RECOMMENDED_HARNESS_IMAGE`) as soon as it becomes healthy. A mismatch — or a harness too
  old to report a version at all — fails the dispatch with an actionable message (re-pull the
  image / update the package). A custom override (`LOCAL_HARNESS_IMAGE` / `LOCAL_HARNESS_ENTRY`)
  downgrades the mismatch to a warning, mirroring the boot-time custom-image notice.

Bumps the executor-harness image tag (harness `src/**` + `Dockerfile` changed) and the local
mode pin to `cat-factory-executor:1.40.0`.
