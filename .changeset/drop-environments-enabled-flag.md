---
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': patch
---

Remove the `ENVIRONMENTS_ENABLED` deployment flag; the ephemeral-environment
integration now assembles wherever the shared `ENCRYPTION_KEY` is set, the same
"always on where the key is present" model as the document/task sources.

The flag was a footgun: it defaulted off and its only effect was to make the whole
integration silently inert (auto-detect 503ing with `unavailable`) even when the real
prerequisites — an encryption key plus a registered per-workspace connection — were
present. Whether a workspace provisions anything is already governed by whether it
connects a provider and whether its pipeline includes a `deployer`/`tester` step, so to
keep environments out of a pipeline you simply omit those steps. `EnvironmentsConfig`
drops its `enabled` field and the module gates on `encryptionKey` presence in all three
runtimes.

Breaking: `ENVIRONMENTS_ENABLED` is no longer read; remove it from deployment config
(setting it has no effect). The inspector's dedicated "ephemeral environments aren't
enabled" auto-detect panel is removed with it, since that off state no longer exists.
