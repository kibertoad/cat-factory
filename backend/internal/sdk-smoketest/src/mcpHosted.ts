// Driving the deployment's own HOSTED MCP endpoint the way a remote host does.
//
// `POST /api/v1/mcp` is the same `createCatFactoryMcpServer` the spawned binary next door runs,
// mounted on the backend behind the public-API key gate. The unit tests drive that handler as a
// function and the conformance suite drives it through each facade's `app.fetch`; neither of those
// can see the part that only exists once there is a SOCKET — that a real Streamable HTTP client
// negotiates with it over the wire, that the `Authorization` header survives the hop, and that a
// tool's own call loops back through the deployment's real API and returns real rows.
//
// It is also the only check in the repo that can see the hosted endpoint and the stdio binary answer
// DIFFERENTLY. Both phases run against the same backend and the same seeded board, so a divergence
// in the tool table, the instructions or the result shape shows up as one phase's observation moving
// while the other's does not.
//
// Graded, not compared, for the same reason as the stdio phase: there is one implementation, so every
// entry below is an absolute claim rather than a cross-implementation agreement.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type ParityProblem, render, sameValue } from './parity.ts'

export interface HostedMcpContext {
  baseUrl: string
  adminKey: string
  /** A `read`-scoped key, so the scope→tool-list mapping is observed rather than assumed. */
  readKey: string
}

export interface HostedMcpReport {
  observations: Record<string, unknown>
  failures: string[]
}

/** What must hold on the hosted endpoint regardless of anything else the run observed. */
const HOSTED_EXPECTED: Record<string, unknown> = {
  // The gate, before any tool list is handed out.
  anonymousRefused: 401,
  bogusKeyRefused: 401,
  // Stateless and JSON-answering. A session id would be sent back to an isolate or instance that
  // never had it; a held-open stream on a request-scoped runtime delivers one response.
  noSessionHeader: true,
  jsonResponseNotStream: true,
  streamVerbRefused: 405,
  // The protocol handshake over real HTTP, and the prose a host reads before any tool.
  serverNamedItself: true,
  instructionsNamePlatform: true,
  instructionsExplainPolling: true,
  // A tool call end to end: the endpoint → the loopback → the real API → a real row, read back
  // through the REST surface with the protocol out of the picture.
  discoveredServiceId: true,
  structuredContentValidated: true,
  createdTaskEchoesTitle: true,
  taskReadableOverRest: true,
  // A deployment refusal is tool CONTENT carrying its own vocabulary, never a protocol error.
  notFoundIsToolError: true,
  // The key is the boundary, and the tool list plus the instructions both say so.
  readKeyHasNoWrites: true,
  readKeyToldWhy: true,
  withheldToolNamesWhatIsAvailable: true,
}

/** Drive the hosted endpoint end to end and report what it did. */
export async function runHostedMcpPhase(context: HostedMcpContext): Promise<HostedMcpReport> {
  const observations: Record<string, unknown> = {}
  const failures: string[] = []
  const endpoint = `${context.baseUrl}/api/v1/mcp`

  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await step('refuses a caller with no usable key', async () => {
    // Raw POSTs rather than a client, because the claim is about the HTTP status: a client turns a
    // 401 into a connection error that says less than the number does.
    observations.anonymousRefused = (await rawInitialize(endpoint, null)).status
    observations.bogusKeyRefused = (await rawInitialize(endpoint, 'cf_live_nope.nope')).status
  })

  await step('answers statelessly, with a JSON body', async () => {
    const answered = await rawInitialize(endpoint, context.adminKey)
    observations.noSessionHeader = answered.sessionId === null
    observations.jsonResponseNotStream = (answered.contentType ?? '').includes('application/json')
  })

  await step('refuses the stream verb rather than 404-ing the URL', async () => {
    // A 404 here reads to a client as "no MCP endpoint at this address" and it gives up on the
    // deployment; a 405 is the spec's own way of saying "POST me".
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${context.readKey}` },
    })
    await response.text()
    observations.streamVerbRefused = response.status
  })

  await step('drives the endpoint a remote host would connect to', async () => {
    const session = await openSession(endpoint, context.adminKey)
    try {
      observations.serverNamedItself = session.client.getServerVersion()?.name === 'cat-factory'
      const instructions = session.client.getInstructions() ?? ''
      observations.instructionsNamePlatform = instructions.includes('cat-factory')
      observations.instructionsExplainPolling = instructions.includes('`tasks_get_run`')

      const { tools } = await session.client.listTools()
      observations.hostedToolCount = tools.length

      // Discovered rather than handed in, so the flow is the one a model actually takes.
      const services = (await session.client.callTool({
        name: 'services_list',
        arguments: {},
      })) as { structuredContent?: { services?: { serviceId?: string }[] } }
      const serviceId = services.structuredContent?.services?.[0]?.serviceId ?? ''
      observations.discoveredServiceId = serviceId.length > 0

      const created = (await session.client.callTool({
        name: 'tasks_create',
        arguments: { serviceId, body: { title: 'Hosted MCP task', taskType: 'feature' } },
      })) as { structuredContent?: Record<string, unknown> }
      // `callTool` throws unless a schema-declaring tool answers with structured content that
      // VALIDATES, so reaching this line is the assertion that the published schemas match what this
      // deployment really answers — over the hosted path as well as the spawned one.
      observations.structuredContentValidated = created.structuredContent !== undefined
      observations.createdTaskEchoesTitle = created.structuredContent?.title === 'Hosted MCP task'

      // The write reached the deployment's own store rather than some parallel state: read it back
      // over REST, with the same key, outside the protocol entirely.
      const taskId = String(created.structuredContent?.taskId ?? '')
      const overRest = await fetch(`${context.baseUrl}/api/v1/tasks/${taskId}`, {
        headers: { authorization: `Bearer ${context.adminKey}` },
      })
      const task = (await overRest.json()) as { title?: string }
      observations.taskReadableOverRest = overRest.ok && task.title === 'Hosted MCP task'

      const missing = (await session.client.callTool({
        name: 'tasks_get',
        arguments: { taskId: 'blk_definitely_not_a_task' },
      })) as { isError?: boolean; content?: { text?: string }[] }
      // The deployment's own code, passed through verbatim: a protocol error would be reported to the
      // host as the server misbehaving and never shown to the model, the one reader that can act.
      observations.notFoundIsToolError =
        missing.isError === true && textOf(missing).includes('not_found')
    } finally {
      await session.close()
    }
  })

  await step('narrows the tool list to the key’s scope, and says why', async () => {
    const session = await openSession(endpoint, context.readKey)
    try {
      const names = (await session.client.listTools()).tools.map((tool) => tool.name)
      observations.readKeyToolCount = names.length
      observations.readKeyHasNoWrites = !names.includes('tasks_create')
      // The fix is a wider KEY rather than an operator's edit to a config file, and a model told only
      // "the writes are hidden" argues with whoever is nearest instead of asking for one.
      observations.readKeyToldWhy = (session.client.getInstructions() ?? '').includes('READ-scoped')

      const withheld = (await session.client.callTool({
        name: 'tasks_create',
        arguments: { serviceId: 'blk_x', body: { title: 'nope', taskType: 'feature' } },
      })) as { isError?: boolean; content?: { text?: string }[] }
      // Named rather than opaque: on a narrowed server the tool exists in the deployment and not
      // here, so the reply lists what IS available instead of implying the platform lacks it.
      observations.withheldToolNamesWhatIsAvailable =
        withheld.isError === true && textOf(withheld).includes('services_list')
    } finally {
      await session.close()
    }
  })

  return { observations, failures }
}

/** Grade the report against {@link HOSTED_EXPECTED}. */
export function compareHostedMcpReport(report: HostedMcpReport): ParityProblem[] {
  const problems: ParityProblem[] = report.failures.map((failure) => ({
    kind: 'failure' as const,
    detail: `[mcp-hosted] ${failure}`,
  }))
  for (const [key, expected] of Object.entries(HOSTED_EXPECTED)) {
    const actual = report.observations[key]
    if (!sameValue(actual, expected)) {
      problems.push({
        kind: 'expectation',
        detail: `[mcp-hosted] '${key}' is ${render(actual)}, expected ${render(expected)}`,
      })
    }
  }
  return problems
}

interface HostedSession {
  client: Client
  close: () => Promise<void>
}

/** Connect a real MCP client over the real Streamable HTTP transport, authenticated by a key. */
async function openSession(endpoint: string, apiKey: string): Promise<HostedSession> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    // A hosted endpoint's credential rides the HTTP request, which is the whole point of it: nothing
    // to spawn, and no long-lived key in a host's config file.
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  })
  const client = new Client({ name: 'cat-factory-sdk-smoketest-hosted', version: '0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}

/** One raw `initialize` POST, for the claims that are about the HTTP layer itself. */
async function rawInitialize(
  endpoint: string,
  apiKey: string | null,
): Promise<{ status: number; sessionId: string | null; contentType: string | null }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '0' },
      },
    }),
  })
  await response.text()
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    contentType: response.headers.get('content-type'),
  }
}

/** The text of a tool result (this facade only ever returns text content). */
function textOf(result: { content?: { text?: string }[] }): string {
  return (result.content ?? []).map((part) => part.text ?? '').join('\n')
}
