---
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
---

Local mode now advertises the `cat-factory env` CLI when it fails to boot for a missing or invalid
mandatory config value. The misconfiguration fallback (both the terminal log and the SPA's "backend
misconfigured" screen) prepends a one-step remedy — `npx @cat-factory/cli env` generates a
ready-to-run local-mode `.env` with every required value at once — above the per-variable remedies,
so a developer can fix the whole file in one command instead of satisfying each secret/URL by hand.

It covers every mandatory value: the three crypto secrets validated by `applyLocalDefaults`
(`AUTH_SESSION_SECRET`, `ENCRYPTION_KEY`, `HARNESS_SHARED_SECRET`) and `DATABASE_URL`, which is
validated inside the reused Node boot. The Node facade's `start()` gains an optional
`augmentConfigProblems` seam that layers the facade-specific advice onto the problems it catches
itself; the hosted Node/Worker facades pass nothing, so their remedies are unchanged.
