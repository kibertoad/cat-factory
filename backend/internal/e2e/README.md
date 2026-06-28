# @cat-factory/e2e

Playwright end-to-end suite for the **assembled product**: a real Chromium drives the
real SPA (the `@cat-factory/app` Nuxt layer, served via the `deploy/frontend` consumer),
which talks to a **real Node backend** — real Postgres, real pg-boss durable execution,
and the real WebSocket push transport.

Only the **external** dependencies are faked, so the suite is deterministic, needs no
secrets, no Docker and no network:

| External dep                         | Faked with                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| LLMs + per-run agent containers      | `FakeAgentExecutor` (the canonical conformance fake) — no LLM HTTP, no Docker    |
| repo bootstrap                       | `FakeRepoBootstrapper`                                                           |
| GitHub App / email / Slack / Datadog | left **off** (all opt-in; the board renders and gates pass through without them) |

Everything else is production code: the controllers, the (dev-open) auth gate, the
durable execution worker + sweepers, and the per-workspace real-time hub. So a run
started over REST advances durably and the SPA updates **live over the WebSocket**, just
with a fake agent doing the "work".

See [`src/testServer.ts`](./src/testServer.ts) for the backend wiring (it reuses the
`buildContainer` seam of `@cat-factory/node-server`'s `start()`).

## Specs

Every spec follows the same signature pattern: **seed/trigger over REST, then assert only on
LIVE pushed UI updates** (no reloads, no fragile canvas drag/zoom). Shared setup lives in
[`tests/fixtures.ts`](./tests/fixtures.ts): a `seededBoard` fixture (seed → pin → open) and an
**auto** `pageErrors` fixture that fails any test on an uncaught SPA exception. Common helpers

- named timeouts are in [`tests/helpers.ts`](./tests/helpers.ts).

| Spec                    | Covers                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot.spec.ts`          | The product boots: the real SPA renders a seeded board from the real backend, no login gate.                                                                                                                                                 |
| `run.spec.ts`           | Flagship: start a run → it parks on a decision live → resolve it in the UI → it reaches a terminal state, all over the WebSocket.                                                                                                            |
| `notifications.spec.ts` | A merger-less run raises a `pipeline_complete` notification live; the inbox bell + item render and acting / dismissing resolves it. (The real PR merge needs GitHub and is covered by the backend conformance suites, not here.)             |
| `create-task.spec.ts`   | Create a task through the real add-task modal → the new card appears on the board.                                                                                                                                                           |
| `approval-gate.spec.ts` | A per-step human **approval** gate parks the run; Approve in the full-screen step-detail rail and it advances. (Distinct from the agent-raised decision in `run.spec`.)                                                                      |
| `reset-run.spec.ts`     | The destructive run-lifecycle control: **Reset** a parked run from the task inspector → the `cancelExecution` path discards it and the task returns to `planned` live. (The dual of resolving/approving — nothing else covers cancel/reset.) |

## Mocking other externals (when a spec needs a real outbound call)

The default suite needs no network mocks. If a future spec must exercise a real outbound
code path (e.g. the real `FetchGitHubClient`, or an inline LLM call), mock at the
backend's **outbound boundary** with **MSW** (intercepts `fetch` in-process) or inject a
port fake via `buildNodeContainer`'s `githubClient` seam — not in the browser, since the
SPA only ever talks to this backend.

## Running

Needs a reachable Postgres in `DATABASE_URL` (CI provides one; locally use
`deploy/local`'s `pnpm db:up`). From the repo root:

```bash
pnpm build                               # build the workspace libraries (e2e imports their dist)
pnpm --filter @cat-factory/e2e exec playwright install chromium
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cat_factory_test \
  pnpm --filter @cat-factory/e2e run test:e2e
```

Playwright's `webServer` boots both the backend (`src/testServer.ts`) and the SPA
(`deploy/frontend`'s `nuxt dev`, pointed at the backend via `NUXT_PUBLIC_API_BASE`).
Use `test:e2e:ui` for the interactive runner. The suite is **not** part of the unit
`test:run` lane — it runs in its own CI job (`.github/workflows/ci.yml` → `Test e2e`).
That job is **non-blocking**: it isn't wired into the aggregated `Test` gate, so a
browser/boot flake can't block an otherwise-green PR. Promote it into `test-gate.needs`
once it has proven stable.

### Test isolation

Specs share one Postgres datastore (`workers: 1`, `fullyParallel: false`), but each spec
**seeds its own workspace** and pins it client-side (`pinWorkspace`), so concurrent
workspaces never collide and no per-test DB teardown is needed. CI runs against a fresh,
ephemeral Postgres service per run, so accumulated rows are discarded with the container;
a retried spec simply seeds a new workspace. If a future spec needs a clean global state,
add a `globalSetup` that truncates rather than relying on ordering.

### Knobs

- `E2E_DECISION_ON_STEPS` (default `0`) — agent-step indices where the fake agent raises a
  one-shot human decision, so the decision-gate flow can be exercised. Empty disables it.
- `E2E_DISPATCH_THROW_KINDS` / `E2E_ASYNC_KINDS` — comma-separated agent kinds. When either is
  set the backend builds the **async** fake (`AsyncFakeAgentExecutor`): `E2E_ASYNC_KINDS` drives
  those kinds through the polled `awaiting_job` loop, and `E2E_DISPATCH_THROW_KINDS` makes their
  container dispatch throw (so the engine's dispatch-failure path runs). Empty ⇒ the default
  inline fake (the existing specs are byte-identical). Reserved for a future failure/retry spec
  booted via its own `webServer`.
- `E2E_CONFIDENCE` (default `1`) — the confidence the fake reports on the final step (drives
  auto-merge vs PR-ready).
- `E2E_CHROMIUM_PATH` — opt-in: launch Chromium from this path instead of a `playwright
install` download. For sandboxes that ship a preinstalled browser and block the download
  (e.g. `E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium`). Unset in CI.
- `PORT` (default `8787`), `E2E_FRONTEND_PORT` (default `3000`), `E2E_BACKEND_URL`.

### Promoting the e2e job to a required gate

`test-e2e` is intentionally **non-blocking** today. Promote it into `test-gate.needs` (in
`.github/workflows/ci.yml`) once it has earned trust:

1. The suite has been green on `main` for ~10+ consecutive runs with **no** retries kicking in
   (a retry that rescues a run still counts as a flake to investigate first).
2. No spec relies on a fixed sleep — only web-first assertions (`toBeVisible` / `expect.poll`).
3. The cold-start `BOOT_TIMEOUT` comfortably covers the CI runner's first board paint.

Until then a browser/boot flake stays advisory and can't block an otherwise-green PR.
