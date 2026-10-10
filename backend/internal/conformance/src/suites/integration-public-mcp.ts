import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from '../harness.js'

// Cross-runtime conformance for the HOSTED MCP endpoint (`POST /api/v1/mcp`).
//
// The protocol itself is `@cat-factory/mcp-server`'s and is pinned by that package's own tests
// against a real MCP client. What belongs HERE is everything those cannot see, because it only
// exists once the endpoint is MOUNTED on a facade: that each facade mounts it at all, that the key
// gate refuses before a tool list is handed out, that the key's SCOPE decides which tools are
// listed, and above all that a tool call loops back through the SAME facade's `/api/v1` under the
// caller's own key and reaches its real store.
//
// That last one is the whole design. A facade that mounted the endpoint but wired the loopback
// wrongly answers `initialize` and `tools/list` perfectly and then returns nothing from every tool,
// which reads to a model like an empty workspace rather than a broken deployment. So the assertions
// go all the way to a row this suite created.
//
// See backend/docs/public-api.md §Hosted MCP endpoint.

/** What every MCP request must send: the transport refuses a caller that accepts only one of these. */
const MCP_HEADERS = { accept: 'application/json, text/event-stream' }

interface JsonRpcReply<T> {
  result?: T
  error?: { code: number; message: string }
}

interface ToolList {
  tools: { name: string; annotations?: { readOnlyHint?: boolean } }[]
}

interface ToolCall {
  isError?: boolean
  content?: { text?: string }[]
  structuredContent?: Record<string, unknown>
}

/** Mint a public-API key of the given scope and return its bearer header. */
async function mintKey(
  app: ConformanceApp,
  workspaceId: string,
  scope: 'read' | 'write' | 'decide' | 'admin',
): Promise<Record<string, string>> {
  const created = await app.call<{ secret: string }>(
    'POST',
    `/workspaces/${workspaceId}/public-api-keys`,
    { label: `conformance-mcp-${scope}`, scope },
  )
  expect(created.status).toBe(201)
  return { authorization: `Bearer ${created.body.secret}` }
}

/** One JSON-RPC round trip against the mounted endpoint. */
async function rpc<T>(
  app: ConformanceApp,
  auth: Record<string, string>,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ status: number; body: JsonRpcReply<T> }> {
  return app.call<JsonRpcReply<T>>(
    'POST',
    '/api/v1/mcp',
    { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    { ...MCP_HEADERS, ...auth },
  )
}

/**
 * Initialize the session, then run `fn`.
 *
 * The handshake is not skippable even on a stateless endpoint: a `tools/list` that arrives without
 * one is answered by the protocol layer rather than the tool table, so driving it in order is what
 * makes the rest of the assertions be about this endpoint.
 */
async function initialized(app: ConformanceApp, auth: Record<string, string>): Promise<void> {
  const init = await rpc<{ serverInfo: { name: string }; instructions?: string }>(
    app,
    auth,
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'conformance', version: '0' },
    },
  )
  expect(init.status).toBe(200)
  expect(init.body.result?.serverInfo.name).toBe('cat-factory')
}

export function definePublicMcpConformance(harness: ConformanceHarness): void {
  describe('public API — hosted MCP endpoint', () => {
    it('serves the tool table and reaches the facade’s own API under the caller’s key', async () => {
      const app = harness.makeApp()
      // Public-API keys are ACCOUNT-scoped, so the mint route refuses an account-less board.
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const auth = await mintKey(app, workspace.id, 'write')
      await initialized(app, auth)

      const listed = await rpc<ToolList>(app, auth, 'tools/list')
      expect(listed.status).toBe(200)
      const names = listed.body.result?.tools.map((tool) => tool.name) ?? []
      // A write key sees both halves. The counts move as `/api/v1` grows, so the assertion is on
      // membership rather than a total that would have to be edited by every future endpoint.
      expect(names).toContain('services_list')
      expect(names).toContain('tasks_create')

      // The loopback, end to end: a tool call must reach THIS facade's block store. A mount that
      // built the client against the wrong origin, or dropped the caller's key, answers this with an
      // empty list or an auth error rather than the seeded board.
      const services = await rpc<ToolCall>(app, auth, 'tools/call', {
        name: 'services_list',
        arguments: {},
      })
      expect(services.status).toBe(200)
      expect(services.body.result?.isError).toBeFalsy()
      const list = services.body.result?.structuredContent as
        | { services?: { serviceId: string }[] }
        | undefined
      expect(list?.services?.length).toBeGreaterThan(0)

      // …and a WRITE reaches the store for real, so the endpoint is not merely readable. Read back
      // over REST rather than over MCP: the same row seen through the other surface is what proves
      // the loopback wrote to the facade's own database and not to some parallel state.
      const serviceId = list!.services![0]!.serviceId
      const created = await rpc<ToolCall>(app, auth, 'tools/call', {
        name: 'tasks_create',
        arguments: { serviceId, body: { title: 'Hosted MCP task', taskType: 'feature' } },
      })
      expect(created.body.result?.isError).toBeFalsy()
      const taskId = String(created.body.result?.structuredContent?.taskId ?? '')
      expect(taskId).not.toBe('')
      const overRest = await app.call<{ title: string }>(
        'GET',
        `/api/v1/tasks/${taskId}`,
        undefined,
        auth,
      )
      expect(overRest.status).toBe(200)
      expect(overRest.body.title).toBe('Hosted MCP task')
    })

    it('refuses an absent or unknown key before it hands out a tool list', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      // The tool list is not a secret, but a `tools/list` answered to an anonymous caller advertises
      // a deployment's whole capability set and invites a model to start calling it.
      const anonymous = await rpc(app, {}, 'tools/list')
      expect(anonymous.status).toBe(401)
      const bogus = await rpc(app, { authorization: 'Bearer cf_live_nope.nope' }, 'tools/list')
      expect(bogus.status).toBe(401)
      // A real key still works on the same endpoint, so the refusals above are the gate rather than
      // the endpoint being absent on this facade.
      const auth = await mintKey(app, workspace.id, 'read')
      await initialized(app, auth)
    })

    it('lists only the reading tools for a read-scoped key, and says why', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const auth = await mintKey(app, workspace.id, 'read')

      const init = await rpc<{ instructions?: string }>(app, auth, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'conformance', version: '0' },
      })
      // The cause is stated, and it is the one whose fix is a wider KEY rather than an operator's
      // edit to a host config. A model told only "writes are hidden" argues with the wrong person.
      expect(init.body.result?.instructions ?? '').toContain('READ-scoped')

      const listed = await rpc<ToolList>(app, auth, 'tools/list')
      const tools = listed.body.result?.tools ?? []
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true)
      expect(tools.map((tool) => tool.name)).not.toContain('tasks_create')
    })

    it('leaves the per-tool scope ladder to the API rather than re-deciding it', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      // A `write` key is above the read floor, so every write tool is listed — including the two the
      // API itself gates on `admin`. That is deliberate: the endpoint filters only what it can know
      // exactly, and the refusal comes from the ONE authority on the question.
      const auth = await mintKey(app, workspace.id, 'write')
      await initialized(app, auth)
      const deleted = await rpc<ToolCall>(app, auth, 'tools/call', {
        name: 'tasks_delete',
        arguments: { taskId: 'task_login' },
      })
      // A tool ERROR carrying the deployment's own vocabulary, not a protocol error: a protocol error
      // is reported to the host as the server misbehaving and never shown to the model, which is the
      // one reader that can act on "this needs an admin key".
      expect(deleted.status).toBe(200)
      expect(deleted.body.result?.isError).toBe(true)
      expect(deleted.body.result?.content?.map((part) => part.text ?? '').join('\n')).toContain(
        'insufficient_scope',
      )
    })

    it('refuses the stream and session verbs with the protocol’s own 405', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const auth = await mintKey(app, workspace.id, 'read')
      // Stateless and JSON-answering, so there is no stream to GET. Answered rather than 404'd,
      // because a client reads a 404 as "no MCP endpoint at this URL" and gives up on the deployment.
      for (const method of ['GET', 'DELETE']) {
        const refused = await app.call(method, '/api/v1/mcp', undefined, {
          ...MCP_HEADERS,
          ...auth,
        })
        expect(refused.status).toBe(405)
      }
    })
  })
}
