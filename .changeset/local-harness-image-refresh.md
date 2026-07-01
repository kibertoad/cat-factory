---
---

docs/deploy: add a harness-image refresh preflight to the local-mode example deployment
(`deploy/local`) so `pnpm dev`/`pnpm start` refresh `LOCAL_HARNESS_IMAGE` before boot,
preventing per-run agent containers from silently running a stale executor-harness image.
Deploy-package + docs only; no versioned package changed.
