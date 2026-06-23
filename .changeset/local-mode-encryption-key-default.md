---
'@cat-factory/local-server': patch
---

Default `ENCRYPTION_KEY` in local mode so the server boots out of the box. The
Node config loader requires `ENCRYPTION_KEY` (it backs credential encryption at
rest), but `applyLocalDefaults` only defaulted the auth/session/PUBLIC_URL vars,
so a stock local install crashed on boot with "ENCRYPTION_KEY is required" despite
the docs promising a local default. It now generates a per-process key when unset,
mirroring `AUTH_SESSION_SECRET`. Set `ENCRYPTION_KEY` explicitly to keep
encrypted-at-rest credentials decryptable across restarts.
