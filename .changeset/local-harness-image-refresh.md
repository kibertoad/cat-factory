---
'@cat-factory/local-server': minor
---

Local mode now pins the executor-harness image to the version it was released against and
refreshes it at boot, so a rerun can't launch a stale — or, via a mutable `:latest`, a
too-new — harness image (versions aren't guaranteed compatible across the image/backend
boundary).

- `LOCAL_HARNESS_IMAGE` is now **optional**: unset resolves to the backend-matched
  `RECOMMENDED_HARNESS_IMAGE` (`resolveHarnessImage`), so a stock deployment runs the
  matched image out of the box.
- `startLocal()` refreshes the resolved image during its runtime preflight (best-effort;
  falls back to the local copy if the registry is unreachable). Disable with
  `LOCAL_HARNESS_IMAGE_REFRESH=off`. Auto-refresh is skipped on the Apple `container`
  runtime (its CLI verbs differ).
- An explicit image that differs from the matched pin — or is a mutable tag — is warned
  about at boot.

Release note: bump `RECOMMENDED_HARNESS_IMAGE` in lockstep with the harness image.
