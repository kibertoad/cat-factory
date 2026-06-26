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

### Knobs

- `E2E_DECISION_ON_STEPS` (default `0`) — agent-step indices where the fake agent raises a
  one-shot human decision, so the decision-gate flow can be exercised. Empty disables it.
- `PORT` (default `8787`), `E2E_FRONTEND_PORT` (default `3000`), `E2E_BACKEND_URL`.
