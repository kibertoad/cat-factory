import type { TrackerSettings, WorkspaceSnapshot } from '@cat-factory/kernel'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { buildNodeContainer } from '../src/container.js'
import { taskConnections } from '../src/db/schema.js'
import { createApp } from '../src/server.js'
import { setupTestDb } from './harness.js'

// Per-tenant Jira wiring on the Node facade: a tenant connects its OWN Jira site
// through the existing task-source UI/endpoint, the credentials are stored
// per-workspace and encrypted at rest, and the tech-debt tracker resolves THAT
// workspace's credentials. This asserts the new Node pieces (WebCryptoSecretCipher,
// the Drizzle task-connection store, the Jira provider, the env-gated wiring) behave
// like the Cloudflare facade. Runs only when DATABASE_URL is set (CI provides it).

const databaseUrl = process.env.DATABASE_URL

const TASKS_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AUTH_DEV_OPEN: 'true',
  ENVIRONMENT: 'test',
  TASKS_ENABLED: 'true',
  // 32 zero bytes, base64 — a valid master key for the test cipher.
  TASKS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  TASK_SOURCES: 'jira',
}

if (databaseUrl) {
  const db = await setupTestDb()

  function app() {
    const container = buildNodeContainer({ db, env: TASKS_ENV })
    return { container, app: createApp(container, TASKS_ENV) }
  }

  async function call<T>(
    a: ReturnType<typeof createApp>,
    method: string,
    path: string,
    body?: unknown,
  ) {
    const hasBody = body !== undefined
    const res = await a.fetch(
      new Request(`https://cat-factory.test${path}`, {
        method,
        headers: hasBody ? { 'content-type': 'application/json' } : undefined,
        body: hasBody ? JSON.stringify(body) : undefined,
      }),
    )
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
  }

  describe('[node] per-tenant Jira + tracker', () => {
    it('assembles the tasks module when TASKS_ENABLED + key are set', () => {
      const { container } = app()
      expect(container.tasks).toBeTruthy()
      expect(container.tasks!.connectionService.listSources().map((s) => s.source)).toContain(
        'jira',
      )
    })

    it('stores a tenant Jira connection encrypted and round-trips the credentials', async () => {
      const { container, app: a } = app()
      const ws = (await call<WorkspaceSnapshot>(a, 'POST', '/workspaces', { seed: false })).body
        .workspace.id

      // Connect through the same service the UI endpoint uses.
      await container.tasks!.connectionService.connect(ws, 'jira', {
        baseUrl: 'https://acme.atlassian.net',
        accountEmail: 'dev@acme.com',
        apiToken: 'secret-token',
      })

      // The credential bag is encrypted at rest (never plaintext)...
      const [row] = await db
        .select({ credentials: taskConnections.credentials })
        .from(taskConnections)
        .where(and(eq(taskConnections.workspace_id, ws), eq(taskConnections.source, 'jira')))
      expect(row?.credentials ?? '').toMatch(/^v1\./)
      expect(row?.credentials ?? '').not.toContain('secret-token')

      // ...and reads back decrypted for the resolver the tracker uses.
      const record = await container.tasks!.connectionService.requireConnection(ws, 'jira')
      expect(record.credentials.apiToken).toBe('secret-token')
      expect(record.credentials.baseUrl).toBe('https://acme.atlassian.net')
    })

    it('persists the workspace tracker selection alongside it', async () => {
      const { app: a } = app()
      const ws = (await call<WorkspaceSnapshot>(a, 'POST', '/workspaces', { seed: false })).body
        .workspace.id
      const put = await call<TrackerSettings>(a, 'PUT', `/workspaces/${ws}/tracker-settings`, {
        tracker: 'jira',
        jiraProjectKey: 'ENG',
      })
      expect(put.body.tracker).toBe('jira')
      expect(put.body.jiraProjectKey).toBe('ENG')
    })
  })
} else {
  describe.skip('[node] per-tenant Jira + tracker (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
