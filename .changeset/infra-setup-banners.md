---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Warn when required infrastructure is undefined. The workspace snapshot now carries an
`infraSetup` projection (computed server-side in `WorkspaceController` from whatever the
deployment actually wired) that tracks three areas explicitly as `not_defined` /
`configured` / `not_applicable`:

- **Ephemeral environments** (all runtimes that wire the environments integration) —
  `not_defined` when no environment provider connection is registered, so testing agents
  that need a live environment can't run.
- **Agent executor** (remote Node only — Cloudflare has built-in per-run containers, local
  runs on the host) — `not_defined` when no self-hosted runner pool is registered, so NO
  container agents can run.
- **Binary storage** (remote Node only — Cloudflare binds R2, local defaults to a filesystem
  store) — `not_defined` when the account selected no content-storage backend, so UI
  screenshots / reference images have nowhere to live.

The SPA surfaces each `not_defined` area as a loud, per-area setup banner with a deep-link
into the relevant configuration. Dismissing a banner asks whether to hide it just for this
session (re-nags next load) or permanently — "I'm OK with the limitations, don't notify me
again" — the latter persisted per-user in localStorage.
