---
'@cat-factory/executor-harness': patch
'@cat-factory/deploy-harness': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
---

Fix a batch of native-mode (`LOCAL_NATIVE_AGENTS`) agent-harness bugs:

- The harnesses (executor + deploy) now shut down gracefully on SIGTERM/SIGINT:
  every running job is aborted (`JobRegistry.abortAll`) so in-flight `claude`/
  `codex`/git/kubectl children are killed instead of being orphaned. Previously a
  dev-server restart left the agent CLI running unsupervised on the developer's
  login. The abort now targets the child's whole process group (POSIX), so the
  CLI's own grandchildren (a shell tool, a build, its git) die with it rather than
  reparenting to init. Shutdown exits as soon as the aborted jobs settle (capped at
  6s) instead of always waiting the fixed window. Both harness servers also honor a
  new `HARNESS_BIND_HOST` env, which the native transport sets to `127.0.0.1` so the
  unsandboxed agent-spawning API is no longer reachable from the LAN (containers keep
  binding all interfaces).
- The native host-process transport sanitizes the harness child's environment to an
  allow-list (`LOCAL_HARNESS_ENV_ALLOW` extends it), so the orchestrator's secrets
  (DATABASE_URL, ENCRYPTION_KEY, GITHUB_PAT, provider keys) no longer leak into the
  ambient agent's env; the inline ambient CLI runner is sanitized the same way. The
  allow-list keeps the TLS trust-anchor vars (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, ...)
  alongside the proxy vars, so a corporate TLS-terminating proxy still works. The
  deploy transport keeps full inheritance (kubectl/helm need ambient cluster env).
- Process-lifecycle fixes in `LocalProcessRunnerTransport`: a harness that never
  becomes healthy is killed instead of leaking one process per retry, and
  `shutdown()` racing an in-flight lazy start now kills the child instead of
  resurrecting it. The local/Node graceful-shutdown path now invokes the
  container's `onShutdown`, which stops the native harnesses; that call is isolated
  in its own try so a failing pg-boss/pool teardown can't skip it.
- `NativeRoutingRunnerTransport` no longer reports a blanket eviction for refs it
  doesn't know: after an orchestrator restart both `poll` and `release` fall back to
  the container leg (which re-finds a per-run container by label), so a still-running
  container job is re-attached / torn down instead of spuriously re-driven or leaked.
- Config typos are no longer silent: unrecognized `LOCAL_NATIVE_AGENTS` tokens and
  an unrecognized/under-configured `LOCAL_DEPLOY_RUNTIME` now log a boot warning
  (behavior still fails safe).
