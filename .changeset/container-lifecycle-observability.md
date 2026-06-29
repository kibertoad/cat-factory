---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
---

Surface the per-run container's live lifecycle in a container agent's details, and bring
the API Tester window to parity with the Coder.

Previously a container-backed step showed a "Spinning up container…" badge that simply
**vanished** once the container was up, leaving a blank "working" state — you couldn't tell
whether the agent was still preparing the checkout or already making model calls, and there
was no way to see which container the run was on or whether it was up / errored / gone.

- **Live phase.** The executor-harness now exposes its current lifecycle phase
  (`starting` → `clone` → `agent` → `push`) on the running job view — the same marker that
  already drove the stuck-run breadcrumb. The engine threads it through
  (`RunnerJobView` / `AgentJobUpdate`) onto the step so the details show WHAT the container
  is doing: "Preparing workspace" vs "Agent running" vs "Pushing changes".
- **Container identity + address.** The transport now attaches the container's id (the
  Cloudflare Durable Object id; the local Docker container id) and, where one exists, its
  reachable URL (the local host URL) — so a run's details name WHERE it runs.
- **Explicit lifecycle status.** Steps carry a `container` projection
  (`starting` / `up` / `errored`, with `destroyed` derived once the run's container is
  reclaimed), so the details say whether the container is spinning up, running, errored, or
  gone — instead of inferring it from a run-level failure.
- **API Tester parity.** The Tester result window now reuses the same observability the
  Coder's step detail shows — the container lifecycle (status / phase / id / url), the
  ephemeral environment status, and the run's infrastructure attempts + logs — alongside its
  test report, instead of the report alone. The Tester (and the human-test / visual-confirm
  gate helpers) now surface the cold-boot `starting` window before the agent comes up, like
  the Coder, rather than jumping straight to "running".
- **The legacy `startingContainer` boolean is removed** in favour of the richer `container`
  projection everywhere (no dual-signal path): every container-backed step — including the
  gate helpers — now reports its lifecycle through `container`. (Stale persisted steps simply
  drop the field; backwards compatibility is a non-goal.)

Bumps the `@cat-factory/executor-harness` image to `1.24.0` (and the matching tag in
`deploy/backend`).
