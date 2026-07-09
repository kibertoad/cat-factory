import { type APIRequestContext, type Locator, type Page, expect } from '@playwright/test'
// The infra-setup dismissal key + the area list are owned by the contracts package, so the e2e
// seed below shares ONE source of truth with the SPA's `InfraSetupBanner.vue` (no drift).
import { INFRA_SETUP_AREAS, INFRA_SETUP_DISMISSED_STORAGE_KEY } from '@cat-factory/contracts'
// The wire shape is owned by the backend seam (`src/fakeProfile.ts`); import it here so the
// test side can't drift from the control-channel payload the backend parses. Type-only, so it
// pulls in none of that module's runtime deps (`@cat-factory/conformance`).
import type { FakeProfile } from '../src/fakeProfile.ts'

// The backend origin the specs seed/trigger state against. The auth gate is open in the
// e2e backend, so plain REST calls need no token. Override with E2E_BACKEND_URL if the
// backend runs on a non-default port.
export const BACKEND_URL =
  process.env.E2E_BACKEND_URL ?? `http://localhost:${process.env.PORT ?? 8787}`

// The test-only control channel `testServer.ts` listens on (a separate port, so it never
// couples to the app's CORS/auth). Defaults to `PORT + 1` — the same derivation the backend
// uses. A spec `setFakeProfile`s its own freshly-seeded workspace here BEFORE starting a run.
export const CONTROL_URL =
  process.env.E2E_CONTROL_URL ?? `http://localhost:${Number(process.env.PORT ?? 8787) + 1}`

/**
 * Re-export the backend `FakeProfile` so specs get the per-workspace fake-behaviour shape
 * (all fields optional; absent ⇒ base backend behaviour) from the same source of truth as the
 * control channel that consumes it. Set a profile BEFORE starting a run — the backend reads it
 * when the run's first agent step dispatches.
 */
export type { FakeProfile }

/** Register a fake behaviour profile for `workspaceId`. Call BEFORE starting the run. */
export async function setFakeProfile(
  request: APIRequestContext,
  workspaceId: string,
  profile: FakeProfile,
): Promise<void> {
  const res = await request.post(`${CONTROL_URL}/fake-profile`, { data: { workspaceId, profile } })
  if (!res.ok()) throw new Error(`fake-profile control ${res.status()}: ${await res.text()}`)
}

// Shared timeouts for LIVE (WebSocket-pushed) assertions. A live run advances through
// several durable pg-boss steps, so web-first assertions need headroom over the default
// 5s — but we still want NO fixed sleeps. Named here so every spec uses the same budget.
/** A single live-pushed UI transition (a badge appears, a status flips). */
export const LIVE_TIMEOUT = 30_000
/** A run reaching a terminal status (drives through every step). */
export const RUN_TERMINAL_TIMEOUT = 45_000
/** First board paint. The very first navigation pays the Nuxt dev-server route compile,
 * which can dwarf a normal mount, so the canvas gets a wider one-time budget than a live
 * transition. (In a production build this is far quicker; the headroom only costs cold runs.) */
export const BOOT_TIMEOUT = 60_000

interface Workspace {
  id: string
}
interface Block {
  id: string
}
interface Pipeline {
  id: string
}
// The full board read; only the fields the specs touch are typed.
export interface WorkspaceSnapshot {
  workspace: Workspace
  blocks: Block[]
  pipelines: Pipeline[]
}

async function json<T>(res: {
  ok(): boolean
  status(): number
  json(): Promise<unknown>
  text(): Promise<string>
}): Promise<T> {
  if (!res.ok()) {
    throw new Error(`backend ${res.status()}: ${await res.text()}`)
  }
  return (await res.json()) as T
}

/** Create a workspace seeded with the sample architecture (frames + the runnable `task_login`). */
export async function createSeededWorkspace(
  request: APIRequestContext,
): Promise<WorkspaceSnapshot> {
  return json<WorkspaceSnapshot>(
    await request.post(`${BACKEND_URL}/workspaces`, { data: { seed: true } }),
  )
}

/**
 * Create a minimal, deterministic pipeline (no requirements-review / ci / merger gates).
 * `gates` is the optional per-step human-approval array (parallel to `agentKinds`): a `true`
 * at index `i` makes the run park for human approval after step `i` completes.
 */
export async function createSimplePipeline(
  request: APIRequestContext,
  workspaceId: string,
  agentKinds: string[] = ['architect', 'coder'],
  gates?: boolean[],
): Promise<Pipeline> {
  return json<Pipeline>(
    await request.post(`${BACKEND_URL}/workspaces/${workspaceId}/pipelines`, {
      data: { name: 'E2E pipeline', agentKinds, ...(gates ? { gates } : {}) },
    }),
  )
}

/** An initiative as the create endpoint returns it (only the fields the specs read). */
export interface CreatedInitiative {
  /** The initiative-level anchor block placed on the board (also the block planning runs against). */
  block: { id: string }
  /** The persisted initiative entity. */
  initiative: { id: string; blockId: string }
}

/**
 * Create an initiative under the service frame `frameId` from a preset — the same endpoint
 * `CreateInitiativeModal` posts to. Returns the created entity + its anchor block, which the
 * backend pushes onto the board live (`initiative-added`). Planning is started SEPARATELY via the
 * ordinary execution endpoint against the anchor block with the preset's planning pipeline id
 * (there is no dedicated "start planning" route) — see {@link startRun}.
 */
export async function createInitiative(
  request: APIRequestContext,
  workspaceId: string,
  frameId: string,
  presetId: string,
  presetInputs?: Record<string, unknown>,
  title = 'E2E initiative',
): Promise<CreatedInitiative> {
  return json<CreatedInitiative>(
    await request.post(`${BACKEND_URL}/workspaces/${workspaceId}/initiatives`, {
      data: { frameId, title, presetId, ...(presetInputs ? { presetInputs } : {}) },
    }),
  )
}

/** An initiative as the workspace snapshot carries it (only the fields the specs read). */
export interface InitiativeSnapshot {
  id: string
  blockId: string
  status: string
  phases: { id: string; title: string; checkpoint?: boolean; checkpointClearedAt?: number }[]
  items: { id: string; phaseId: string; status: string; blockId?: string | null }[]
}

/**
 * Read one initiative entity off the workspace snapshot by its anchor `blockId`, or null. There is
 * no per-initiative REST endpoint the specs need, so — like {@link findParkedApproval} — this reads
 * the snapshot the SPA itself hydrates from. Used to observe backend-only progression a spec can't
 * see on the board (a phase's item settling, the just-spawned next-phase item's block id).
 */
export async function getInitiative(
  request: APIRequestContext,
  workspaceId: string,
  blockId: string,
): Promise<InitiativeSnapshot | null> {
  const snapshot = await json<{ initiatives?: InitiativeSnapshot[] }>(
    await request.get(`${BACKEND_URL}/workspaces/${workspaceId}`),
  )
  return (snapshot.initiatives ?? []).find((i) => i.blockId === blockId) ?? null
}

/**
 * Connect a (fake) observability provider for the workspace — the `PUT /observability/connection`
 * the Integrations panel posts to. The `post-release-health` gate is observability-gated: a
 * pipeline carrying it is rejected at CREATE unless the workspace has a connection, so a spec that
 * builds such a pipeline calls this first. The credentials are never used at runtime (the gate's
 * verdict comes from the fake release-health provider); only the connection ROW is required.
 */
export async function connectObservability(
  request: APIRequestContext,
  workspaceId: string,
): Promise<void> {
  await json(
    await request.put(`${BACKEND_URL}/workspaces/${workspaceId}/observability/connection`, {
      data: {
        provider: 'datadog',
        credentials: { site: 'datadoghq.com', apiKey: 'e2e-fake-api-key', appKey: 'e2e-fake-app-key' },
      },
    }),
  )
}

/** Start a run of `pipelineId` against `blockId`. */
export async function startRun(
  request: APIRequestContext,
  workspaceId: string,
  blockId: string,
  pipelineId: string,
): Promise<void> {
  await json(
    await request.post(`${BACKEND_URL}/workspaces/${workspaceId}/blocks/${blockId}/executions`, {
      data: { pipelineId },
    }),
  )
}

/** One run's step, as the workspace snapshot returns it (only the fields the specs read). */
interface ExecutionStep {
  agentKind: string
  state: string
  approval?: { id: string; status: string } | null
}
/** One execution instance from the snapshot (only the fields the specs read). */
interface ExecutionInstance {
  id: string
  blockId: string
  status: string
  steps: ExecutionStep[]
}
/** A parked human-approval gate located on a block's live run. */
export interface ParkedApproval {
  executionId: string
  approvalId: string
}

/**
 * Find a block's currently-PARKED human-approval gate for the given step `agentKind`, or null.
 * A `gate: true` pipeline step parks its run `blocked` with the step `waiting_decision` and a
 * `pending` approval — the same generic gate `approval-gate.spec` drives through the UI. The
 * initiative planner gate rides this exact mechanism, but no SPA surface exposes it for an
 * initiative-level block, so its e2e approves it over REST (a trigger). Reads the run off the
 * workspace snapshot (there is no per-block executions endpoint) and returns the parked run +
 * approval ids to approve.
 */
export async function findParkedApproval(
  request: APIRequestContext,
  workspaceId: string,
  blockId: string,
  agentKind: string,
): Promise<ParkedApproval | null> {
  const snapshot = await json<{ executions: ExecutionInstance[] }>(
    await request.get(`${BACKEND_URL}/workspaces/${workspaceId}`),
  )
  for (const instance of snapshot.executions) {
    if (instance.blockId !== blockId) continue
    const step = instance.steps.find(
      (s) =>
        s.agentKind === agentKind &&
        s.state === 'waiting_decision' &&
        s.approval?.status === 'pending',
    )
    if (step?.approval) return { executionId: instance.id, approvalId: step.approval.id }
  }
  return null
}

/** Approve a parked step gate over REST (the endpoint the step-detail "Approve" button calls). */
export async function approveStep(
  request: APIRequestContext,
  workspaceId: string,
  approval: ParkedApproval,
): Promise<void> {
  await json(
    await request.post(
      `${BACKEND_URL}/workspaces/${workspaceId}/executions/${approval.executionId}/steps/${approval.approvalId}/approve`,
      { data: {} },
    ),
  )
}

/** A recurring schedule as the controller returns it (only the fields the specs read). */
export interface Schedule {
  id: string
  /** The reused on-board task block the schedule runs against (the board node to assert on). */
  blockId: string
}

/**
 * Create a recurring-pipeline schedule over REST (the endpoint the recurring modal posts to),
 * attached to the service frame `frameId`. Returns the schedule whose `blockId` is the reused
 * on-board task the backend now pushes live onto the board (`block-added`). A nominal daily
 * cadence is stored, but the spec fires it deterministically via {@link runScheduleNow} rather
 * than waiting on the sweeper.
 */
export async function createSchedule(
  request: APIRequestContext,
  workspaceId: string,
  frameId: string,
  pipelineId: string,
  name = 'E2E recurring',
): Promise<Schedule> {
  return json<Schedule>(
    await request.post(`${BACKEND_URL}/workspaces/${workspaceId}/recurring-pipelines`, {
      data: {
        frameId,
        pipelineId,
        name,
        recurrence: {
          intervalHours: 24,
          weekdays: [],
          windowStartHour: null,
          windowEndHour: null,
          timezone: 'UTC',
        },
      },
    }),
  )
}

/** Fire a schedule immediately (run-now), starting a run against its reused block. */
export async function runScheduleNow(
  request: APIRequestContext,
  workspaceId: string,
  scheduleId: string,
): Promise<void> {
  await json(
    await request.post(
      `${BACKEND_URL}/workspaces/${workspaceId}/recurring-pipelines/${scheduleId}/run-now`,
    ),
  )
}

/** One bootstrap job as the controller returns it (only the fields the specs read). */
export interface BootstrapJob {
  id: string
  status: string
  repoName: string
  /** The provisional service frame the run materialises (the board node to assert on). */
  blockId: string | null
}

/**
 * Start a "bootstrap repo" run over REST (the same endpoint the launch modal calls). Returns
 * immediately with a `running` job whose `blockId` is the provisional service frame now on the
 * board — the spec asserts on that frame's live progress / failure. The fake bootstrapper (see
 * `FakeProfile.bootstrapProgress` / `bootstrapFailWith`) drives the scripted lifecycle.
 */
export async function startBootstrap(
  request: APIRequestContext,
  workspaceId: string,
  repoName: string,
): Promise<BootstrapJob> {
  return json<BootstrapJob>(
    await request.post(`${BACKEND_URL}/workspaces/${workspaceId}/bootstrap/jobs`, {
      data: {
        referenceArchitectureId: null,
        repoName,
        description: 'e2e bootstrap',
        private: true,
        instructions: 'a small Hono API with a /health route',
        type: 'service',
      },
    }),
  )
}

/**
 * Make the SPA open a specific workspace on load by pre-seeding the persisted store
 * (pinia-plugin-persistedstate writes the `workspace` store's picked `workspaceId` to
 * localStorage). Must be called BEFORE `page.goto`.
 *
 * Also permanently dismisses the infra-setup banner for every area. The e2e backend is a
 * stock Node deployment (ENCRYPTION_KEY set ⇒ the runner-pool surface is wired but no pool is
 * registered, content storage defaults to `off`), so the advisory `InfraSetupBanner` would
 * legitimately render a full-width top overlay and intercept clicks on the board chrome the
 * specs drive — orthogonal noise for every non-banner spec. The banner reads its permanent
 * dismissals from `INFRA_SETUP_DISMISSED_STORAGE_KEY` keyed by user id; auth is off in e2e so the
 * key is `local`. Seeding it here (before `goto`, the single choke point every board spec routes
 * through) keeps the suite deterministic without a test-only branch in product code. The key + area
 * list come from `@cat-factory/contracts`, the same source the banner reads, so they can't drift.
 */
export async function pinWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.addInitScript(
    ({ id, dismissKey, areas }) => {
      window.localStorage.setItem('workspace', JSON.stringify({ workspaceId: id }))
      window.localStorage.setItem(dismissKey, JSON.stringify({ local: areas }))
    },
    {
      id: workspaceId,
      dismissKey: INFRA_SETUP_DISMISSED_STORAGE_KEY,
      areas: [...INFRA_SETUP_AREAS],
    },
  )
}

/** Navigate to the board and wait for it to finish bootstrapping (canvas mounted). The
 * canvas only mounts once auth + the workspace snapshot + the GitHub probe have settled,
 * so its visibility is the single readiness signal we need. We then assert the seeded
 * `task_login` card actually rendered, so a mis-pinned workspace (the snapshot loaded but
 * for the wrong/empty workspace) fails loudly here instead of timing out deep in a spec. */
export async function openBoard(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('board-canvas')).toBeVisible({ timeout: BOOT_TIMEOUT })
  await expect(taskCard(page, 'task_login')).toBeVisible({ timeout: LIVE_TIMEOUT })
  // Wait for the real-time WebSocket to actually connect before returning. The board paints
  // from the REST snapshot, but the stream connects asynchronously (it first mints a ticket),
  // so a spec that drove a run the instant the board appeared could have the run's `in_progress`
  // / `blocked` events broadcast to a not-yet-subscribed browser and miss them — the card then
  // sits on a stale status until the assertion times out (intermittent on a loaded CI runner).
  // Gating every spec's setup on a live channel removes that race at the source.
  await expect(page.getByTestId('workspace-stream')).toHaveAttribute('data-connected', 'true', {
    timeout: LIVE_TIMEOUT,
  })
}

/** Locate a task card by its block id (the card root carries `data-block-id`). */
export function taskCard(page: Page, blockId: string): Locator {
  return page.locator(`[data-block-id="${blockId}"]`)
}

/**
 * Resolve the one-shot human decision the fake agent parks (with `E2E_DECISION_ON_STEPS=0`,
 * the default backend). Opens the card's Resolve affordance, picks the first option, and —
 * crucially — asserts the modal actually CLOSED afterward (a modal that fails to dismiss is
 * a real regression the original run.spec never caught). Shared by every run-driving spec.
 */
export async function resolveDecision(page: Page, card: Locator): Promise<void> {
  await card.getByTestId('task-resolve').click()
  const modal = page.getByTestId('decision-modal')
  await expect(modal).toBeVisible()
  await modal.getByTestId('decision-option').first().click()
  await expect(modal).toBeHidden({ timeout: LIVE_TIMEOUT })
}
