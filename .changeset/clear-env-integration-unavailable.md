---
'@cat-factory/app': patch
---

Explain the "Environment integration is not configured" case in service auto-detect instead of showing the raw backend line.

When auto-detecting a service's test-environment config, the backend returns a 503 `unavailable` if the ephemeral-environment integration is off for the deployment. The inspector used to surface the terse server message ("Environment integration is not configured"), which read like a failure of the (working) GitHub connection. It now shows a dedicated panel that says exactly what is off, that it is separate from GitHub, how it gets enabled (`ENVIRONMENTS_ENABLED` + an encryption key on the server), and links the environments-integration docs. Copy added to all locales.
