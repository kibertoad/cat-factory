import type { AgentExecutor, CoreDependencies, WorkspaceSnapshot } from '@cat-factory/core'
import { env } from 'cloudflare:test'
import { createApp } from '../src/app'
import { FakeAgentExecutor } from './fakes/FakeAgentExecutor'

const BASE = 'https://cat-factory.test'

export interface TestResponse<T = unknown> {
  status: number
  body: T
}

export interface TestApp {
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<TestResponse<T>>
  createWorkspace(options?: { name?: string; seed?: boolean }): Promise<WorkspaceSnapshot>
}

/**
 * Build the real Hono app against the real local D1 (`env.DB`), injecting a
 * deterministic agent so tests assert exact engine behaviour. Requests go
 * through `app.fetch` — the actual Worker fetch handler — inside workerd.
 */
export function makeApp(
  agentExecutor: AgentExecutor = new FakeAgentExecutor(),
  overrides: Partial<CoreDependencies> = {},
): TestApp {
  const app = createApp({ overrides: { agentExecutor, ...overrides } })

  async function call<T>(method: string, path: string, body?: unknown): Promise<TestResponse<T>> {
    const hasBody = body !== undefined
    const res = await app.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: hasBody ? { 'content-type': 'application/json' } : undefined,
        body: hasBody ? JSON.stringify(body) : undefined,
      }),
      env,
    )
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
  }

  async function createWorkspace(options: { name?: string; seed?: boolean } = {}) {
    const res = await call<WorkspaceSnapshot>('POST', '/workspaces', options)
    return res.body
  }

  return { call, createWorkspace }
}
