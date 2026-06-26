import { type APIRequestContext, type Locator, type Page, expect } from '@playwright/test'

// The backend origin the specs seed/trigger state against. The auth gate is open in the
// e2e backend, so plain REST calls need no token. Override with E2E_BACKEND_URL if the
// backend runs on a non-default port.
export const BACKEND_URL =
  process.env.E2E_BACKEND_URL ?? `http://localhost:${process.env.PORT ?? 8787}`

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

/**
 * Make the SPA open a specific workspace on load by pre-seeding the persisted store
 * (pinia-plugin-persistedstate writes the `workspace` store's picked `workspaceId` to
 * localStorage). Must be called BEFORE `page.goto`.
 */
export async function pinWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.addInitScript((id) => {
    window.localStorage.setItem('workspace', JSON.stringify({ workspaceId: id }))
  }, workspaceId)
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
