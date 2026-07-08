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

| Spec                            | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot.spec.ts`                  | The product boots: the real SPA renders a seeded board from the real backend, no login gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `run.spec.ts`                   | Flagship: start a run → it parks on a decision live → resolve it in the UI → it reaches a terminal state, all over the WebSocket.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `notifications.spec.ts`         | A merger-less run raises a `pipeline_complete` notification live; the inbox bell + item render and acting / dismissing resolves it. (The real PR merge needs GitHub and is covered by the backend conformance suites, not here.)                                                                                                                                                                                                                                                                                                                                                        |
| `create-task.spec.ts`           | Create a task through the real add-task modal → the new card appears on the board.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `approval-gate.spec.ts`         | A per-step human **approval** gate parks the run; Approve in the full-screen step-detail rail and it advances. (Distinct from the agent-raised decision in `run.spec`.)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `reset-run.spec.ts`             | The destructive run-lifecycle control: **Reset** a parked run from the task inspector → the `cancelExecution` path discards it and the task returns to `planned` live. (The dual of resolving/approving — nothing else covers cancel/reset.)                                                                                                                                                                                                                                                                                                                                            |
| `mobile-shell.spec.ts`          | The responsive shell at a phone viewport (390×844): the sidebar is an off-canvas drawer toggled by the hamburger (open via the trigger, close via the backdrop), the inspector opens as a bottom sheet, and the board chrome doesn't overflow horizontally.                                                                                                                                                                                                                                                                                                                             |
| `mobile-canvas.spec.ts`         | The board canvas at a phone viewport (390×844): the toolbar's zoom-out / zoom-in / fit-view camera controls stay reachable and no minimap is rendered (it was removed altogether). (Touch pan/pinch themselves are a Vue Flow config; not driven here.)                                                                                                                                                                                                                                                                                                                                 |
| `agent-failure-retry.spec.ts`   | A container-dispatch failure faults the run → the block goes `blocked` with the shared `<AgentFailureCard>` (banner + retry) live; the retry control re-drives it. The unified failure/retry surface — nothing else covers a FAILED run through the SPA.                                                                                                                                                                                                                                                                                                                                |
| `merge-review.spec.ts`          | A pipeline ending in a low-confidence `merger` step declines to auto-merge → raises a `merge_review` notification live and leaves the task `pr_ready`; dismissing clears the inbox. (Complements `notifications.spec`'s merger-less `pipeline_complete`.)                                                                                                                                                                                                                                                                                                                               |
| `pipeline-progress.spec.ts`     | A polled async agent kind (the durable `awaiting_job` loop) surfaces live subtask counts in the inspector run panel and drives the run to a terminal state — the async path `run.spec`'s inline decision run never touches.                                                                                                                                                                                                                                                                                                                                                             |
| `bootstrap-live.spec.ts`        | The repo-bootstrap flow: a run materialises a provisional service frame with a live progress badge that then clears; a failed bootstrap surfaces the shared `<AgentFailureCard>` (banner + retry) on the frame. (Triggered over REST; the real GitHub push is off.)                                                                                                                                                                                                                                                                                                                     |
| `recurring-run.spec.ts`         | The recurring-pipeline round-trip: creating a schedule pushes its reused on-board task live (`block-added`, no reload), and firing it via run-now drives THAT block to a terminal status over the WebSocket. (The bug-triage step mechanics live in the conformance suite.)                                                                                                                                                                                                                                                                                                             |
| `initiative-preset.spec.ts`     | The initiative-PRESET flow: create an initiative from a preset (docs-refresh) over REST → its anchor card appears live → the fake-planned run auto-plans (analyst → planner → committer, unattended) and the loop spawns a first-class DECORATED `document` task on the board, all over the WebSocket. The S9 baseline the tech-migration preset E2E extends.                                                                                                                                                                                                                           |
| `tech-migration-preset.spec.ts` | The tech-migration PRESET flow (the second real preset): create a FULL-interview initiative over REST → the `pl_initiative` run's interviewer converges on the seeded qa (fake inline model) → the planner returns a five-phase migration plan the generic ingest normalizer accepts → approve the parked planner gate over REST → the loop spawns the phase-1 blast-zone report as a DECORATED `document` task live. Exercises the interviewer + planner-gate + template-shape + `seedMigrationPlan` decoration the docs-refresh baseline does not.                                    |
| `initiative-checkpoint.spec.ts` | The phase CHECKPOINT flow (custom-initiative D2): a planner-authored `checkpoint: true` phase pauses the initiative once its item reaches `done` (merger-tailed pipeline) → the anchor card flips to `paused` live and phase two has NOT spawned → the tracker window shows the checkpoint pause banner + "awaiting review" phase badge → **Resume (GO)** from the banner spawns phase two's task live, while a sibling spec takes the **Cancel (NO_GO)** branch (card → `cancelled`, phase two never spawns). Proves the checkpoint genuinely gates the next phase in both directions. |

### Per-run fake behaviour (the `setFakeProfile` seam)

The backend boots ONCE and serves every spec (one shared Node process + one production frontend
build), so the fake-agent knobs below can't be flipped globally per spec. Instead a spec sets a
**`FakeProfile`** for its OWN freshly-seeded workspace over a test-only control channel and the
fakes resolve that per-workspace behaviour on each call — the same way existing specs vary
behaviour by choosing a pipeline SHAPE over REST. Call it BEFORE starting the run:

```ts
await setFakeProfile(request, workspaceId, { decisionOnSteps: [], dispatchThrowKinds: ['coder'] })
```

`FakeProfile` (see [`tests/helpers.ts`](./tests/helpers.ts)): `confidence`, `decisionOnSteps`,
`asyncKinds`, `dispatchThrowKinds`, `asyncPolls`, `bootstrapProgress`, `bootstrapFailWith`,
`customResult`, `initiativePlan` (the plan draft the fake `initiative-planner` returns, so an
initiative planning run reaches `executing` and the loop spawns the decorated tasks — the planner
faults without one). A workspace with no profile gets the base backend behaviour, so the
pre-existing specs are unchanged. The channel is a tiny separate HTTP listener on `PORT + 1` (`E2E_CONTROL_PORT`),
posted to from Node (Playwright's `request`), never from the browser — see
[`src/testServer.ts`](./src/testServer.ts) + [`src/fakeProfile.ts`](./src/fakeProfile.ts).

### Inline LLM gates (the `fakeInlineModelResolver` seam)

The `FakeAgentExecutor` above only fakes the CONTAINER/agent steps. A few pipelines run an LLM
**inline** through the `ModelProvider` port instead — the initiative INTERVIEWER (`pl_initiative`),
the document interviewer, the requirements reviewer — and those never touch the agent executor. On
the keyless e2e backend the real per-scope resolver would fault them, so `testServer.ts` injects a
**`fakeInlineModelResolver`** (`src/fakeInlineModel.ts`) via `buildNodeContainer`'s
`overrides.modelProviderResolver`: an `ai/test` mock whose every generate returns a fixed,
immediately-CONVERGING interview decision. It is the inline-LLM sibling of the fake agent executor,
and it lets a full-interview preset's planning run (`tech-migration-preset.spec.ts`) run
deterministically end to end. It is global (not per-workspace) but safe for the other specs: none
assert on an inline-gate OUTCOME (a spawned task's card is asserted on visibility, emitted at spawn
regardless of how its later inline steps resolve).

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

These env vars set the **base** fake behaviour every workspace inherits. A spec overrides them
per-workspace at runtime via `setFakeProfile` (see the seam above); prefer that over the globals,
which mainly exist so a whole-suite run can shift the defaults.

- `E2E_DECISION_ON_STEPS` (default `0`) — agent-step indices where the fake agent raises a
  one-shot human decision, so the decision-gate flow can be exercised. Empty disables it. (A
  spec that wants no gate passes `decisionOnSteps: []` in its profile.)
- `E2E_DISPATCH_THROW_KINDS` / `E2E_ASYNC_KINDS` — comma-separated agent kinds that drive the
  polled `awaiting_job` loop (`E2E_ASYNC_KINDS`) or throw on container dispatch
  (`E2E_DISPATCH_THROW_KINDS`). Normally set PER WORKSPACE via `setFakeProfile` instead.
- `E2E_CONFIDENCE` (default `1`) — the confidence the fake reports on the final step (drives
  auto-merge vs merge-review). Normally set per-workspace via `setFakeProfile`.
- `JOB_POLL_INTERVAL` / `CI_POLL_INTERVAL` (default `1 second` in the e2e backend) — how often
  the durable driver polls an async job / a gate. Shortened from the 15s/30s production cadence
  so a polled `awaiting_job` run settles within the suite timeouts; inline specs never poll.
- `INITIATIVE_LOOP_INTERVAL_MS` (default `1000` in the e2e backend; `60000` in production) — how
  often the Node initiative-execution loop sweeps for `executing` initiatives to spawn the next
  wave of tasks. Shortened so a just-planned initiative spawns its first decorated task within the
  suite timeouts (the planning run's terminal doesn't poke the loop — only the sweep spawns wave 1).
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
