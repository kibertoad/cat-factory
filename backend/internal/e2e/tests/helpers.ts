import { type APIRequestContext, type Page, expect } from '@playwright/test'

// The backend origin the specs seed/trigger state against. The auth gate is open in the
// e2e backend, so plain REST calls need no token. Override with E2E_BACKEND_URL if the
// backend runs on a non-default port.
export const BACKEND_URL =
  process.env.E2E_BACKEND_URL ?? `http://localhost:${process.env.PORT ?? 8787}`

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
interface WorkspaceSnapshot {
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

/** Create a minimal, deterministic pipeline (no requirements-review / ci / merger gates). */
export async function createSimplePipeline(
  request: APIRequestContext,
  workspaceId: string,
  agentKinds: string[] = ['architect', 'coder'],
): Promise<Pipeline> {
  return json<Pipeline>(
    await request.post(`${BACKEND_URL}/workspaces/${workspaceId}/pipelines`, {
      data: { name: 'E2E pipeline', agentKinds },
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
 * so its visibility is the single readiness signal we need. */
export async function openBoard(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('board-canvas')).toBeVisible({ timeout: 30_000 })
}

/** Locate a task card by its block id (the card root carries `data-block-id`). */
export function taskCard(page: Page, blockId: string) {
  return page.locator(`[data-block-id="${blockId}"]`)
}
