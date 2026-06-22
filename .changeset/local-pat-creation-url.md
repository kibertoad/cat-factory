---
'@cat-factory/local-server': patch
---

Local mode now checks for a configured GitHub PAT at boot. When `GITHUB_PAT` is
missing, `startLocal()` logs a warning with a click-through GitHub "new personal
access token (classic)" URL that pre-selects the scopes local mode needs (`repo`,
`workflow`), so the developer can create one in a single step instead of hitting a
runtime failure on the first repo-operating agent step. Exposed as
`githubPatCreationUrl()` from the local facade.
