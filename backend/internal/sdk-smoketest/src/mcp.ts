// Driving the PUBLISHED MCP server the way a host does.
//
// `sdk/mcp` (`@cat-factory/mcp-server`) is a fifth thing rendered from the one OpenAPI spec: not a
// client but a facade that presents the published operations as MCP tools. Its unit tests drive the
// server object over an in-memory transport against a stubbed `fetch`, which covers the protocol and
// the rendering, and structurally cannot cover the part that only exists once there is a PROCESS: a
// `bin` that must start from environment variables alone, keep stdout free for JSON-RPC, exit
// non-zero when it cannot work, and talk to a real deployment over the real SDK.
//
// So this phase spawns the real `dist/bin.js` and speaks the protocol to it, twice: once configured
// the way a host would configure it (including the key FILE, which is the mitigation for a
// long-lived credential sitting in a host's plaintext config), and once with the tool filters set,
// because an env-only knob is only proven by a process that read the env.
//
// This is NOT part of the four-way parity comparison next door: there is one implementation, so
// there is nothing to compare it against and every check here is an absolute claim. It reuses that
// module's problem vocabulary so `run.ts` reports both phases the same way.

import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { type ParityProblem, render, sameValue } from './parity.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/** The built executable. `pnpm build` produces it; CI builds before this harness runs. */
export const MCP_BIN = resolve(repoRoot, 'sdk/mcp/dist/bin.js')

export interface McpContext {
  baseUrl: string
  adminKey: string
  /** A scratch directory the key file is written into. */
  workDir: string
}

export interface McpReport {
  observations: Record<string, unknown>
  failures: string[]
}

/**
 * What must hold, regardless of anything else the run observed.
 *
 * Every entry is an absolute claim: unlike the cross-SDK phase there is no second implementation to
 * disagree with, so the expectations ARE the check. Counts that legitimately move (the tool total
 * grows with the API) are recorded as observations and left out of here.
 */
const MCP_EXPECTED: Record<string, unknown> = {
  // The startup contract. A server that comes up without credentials is reported by the host as
  // connected and then fails every call, which costs a model several turns to work out.
  noCredentialsExitCode: 1,
  noCredentialsNamesTheVariable: true,
  noCredentialsWroteNothingToStdout: true,
  // The mitigation for a key in a host's plaintext config: a path is not a secret.
  startedFromKeyFile: true,
  readyLineOnStderr: true,
  keyAbsentFromStderr: true,
  // The protocol surface a host reads before it reads any tool.
  instructionsNamePlatform: true,
  instructionsExplainPolling: true,
  discoveredServiceId: true,
  // One tool call end to end, through the real SDK against the real deployment.
  createdTaskEchoesTitle: true,
  // Declared `outputSchema` obliges structured content on every success, and the client VALIDATES
  // it, so this is the assertion that the published schemas match what the deployment really
  // answers. It is the only check in the repo that can see them disagree.
  structuredContentValidated: true,
  structuredMatchesText: true,
  // A refusal is tool content carrying the deployment's own vocabulary, never a protocol error.
  notFoundIsToolError: true,
  notFoundCarriesCode: true,
  // A `204` says so rather than rendering an empty string a model reads as a failure.
  noContentIsStated: true,
  // The env-only filters, proven by a process that read them.
  deniedToolAbsent: true,
  deniedToolGroupIntact: true,
  deniedToolStatedInInstructions: true,
  readOnlyServerHasNoWrites: true,
}

/** Drive the published server end to end and report what it did. */
export async function runMcpPhase(context: McpContext): Promise<McpReport> {
  const observations: Record<string, unknown> = {}
  const failures: string[] = []

  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await step('refuses to start unconfigured', async () => {
    const refusal = await startUnconfigured()
    observations.noCredentialsExitCode = refusal.code
    observations.noCredentialsNamesTheVariable = refusal.stderr.includes('CAT_FACTORY_BASE_URL')
    // STDOUT IS THE PROTOCOL. A host reading a human-readable byte on it reports a server that
    // connected and then broke, and the failing case is where a banner is most tempting to write.
    observations.noCredentialsWroteNothingToStdout = refusal.stdout === ''
  })

  // The key goes in a FILE, so the path the mitigation exists for is the one this harness proves.
  const keyFile = join(context.workDir, 'mcp-api-key')
  await writeFile(keyFile, `${context.adminKey}\n`, 'utf8')

  await step('drives the server a host would start', async () => {
    const session = await openSession({
      CAT_FACTORY_BASE_URL: context.baseUrl,
      CAT_FACTORY_API_KEY_FILE: keyFile,
    })
    try {
      observations.startedFromKeyFile = true
      const { tools } = await session.client.listTools()
      observations.toolCount = tools.length
      observations.toolsDeclaringOutputSchema = tools.filter((tool) => tool.outputSchema).length

      const instructions = session.client.getInstructions() ?? ''
      observations.instructionsNamePlatform = instructions.includes('cat-factory')
      // The two SSE operations are absent by design, so "how do I watch a run" is the question the
      // instructions most need to answer; without it a model invents a streaming tool or reports a
      // non-terminal reading as the outcome.
      observations.instructionsExplainPolling = instructions.includes('`tasks_get_run`')

      // Discovered through the tool that exists for it, rather than handed in: that is the route a
      // model takes, and it exercises a list-shaped result on the way to a single-object one.
      const services = (await session.client.callTool({
        name: 'services_list',
        arguments: {},
      })) as { structuredContent?: { services?: { serviceId?: string }[] } }
      const serviceId = services.structuredContent?.services?.[0]?.serviceId ?? ''
      observations.discoveredServiceId = serviceId.length > 0

      const created = (await session.client.callTool({
        name: 'tasks_create',
        arguments: {
          serviceId,
          body: { title: 'MCP smoketest task', taskType: 'feature' },
        },
      })) as { structuredContent?: Record<string, unknown>; isError?: boolean }
      // `callTool` on a tool that declares an `outputSchema` throws unless the result carries
      // structured content that VALIDATES against it, so reaching this line is the assertion.
      observations.structuredContentValidated = created.structuredContent !== undefined
      observations.structuredMatchesText = sameValue(
        created.structuredContent,
        JSON.parse(textOf(created)),
      )
      const taskId = String(created.structuredContent?.taskId ?? '')
      observations.createdTaskEchoesTitle =
        created.structuredContent?.title === 'MCP smoketest task'

      const missing = (await session.client.callTool({
        name: 'tasks_get',
        arguments: { taskId: 'blk_definitely_not_a_task' },
      })) as { isError?: boolean }
      observations.notFoundIsToolError = missing.isError === true
      // The deployment's own vocabulary, passed through verbatim: a 422 naming the field is the most
      // actionable thing this facade ever returns, and a protocol error would hide it from the model.
      observations.notFoundCarriesCode = textOf(missing).includes('not_found')

      const deleted = await session.client.callTool({ name: 'tasks_delete', arguments: { taskId } })
      observations.noContentIsStated = textOf(deleted).includes('returns no content')
      observations.readyLineOnStderr = session.stderr().includes('cat-factory MCP server ready')
      // The credential never appears in what the process says about itself, on any path.
      observations.keyAbsentFromStderr = !session.stderr().includes(context.adminKey)
    } finally {
      await session.close()
    }
  })

  await step('honours the tool filters a host sets in the environment', async () => {
    const session = await openSession({
      CAT_FACTORY_BASE_URL: context.baseUrl,
      CAT_FACTORY_API_KEY: context.adminKey,
      CAT_FACTORY_MCP_EXCLUDE_TOOLS: 'notifications_act',
      CAT_FACTORY_MCP_READ_ONLY: 'true',
    })
    try {
      const names = (await session.client.listTools()).tools.map((tool) => tool.name)
      observations.filteredToolCount = names.length
      observations.deniedToolAbsent = !names.includes('notifications_act')
      // The reason the per-tool filter exists: withholding the PR-merging tool used to cost the
      // whole inbox group it belongs to.
      observations.deniedToolGroupIntact = names.includes('notifications_list')
      observations.readOnlyServerHasNoWrites = !names.includes('tasks_create')
      const instructions = session.client.getInstructions() ?? ''
      // A model that reads the absence as a missing platform feature offers to do it some other way
      // instead of asking the person who switched it off.
      observations.deniedToolStatedInInstructions = instructions.includes('notifications_act')
    } finally {
      await session.close()
    }
  })

  return { observations, failures }
}

/** Grade the report against {@link MCP_EXPECTED}. */
export function compareMcpReport(report: McpReport): ParityProblem[] {
  const problems: ParityProblem[] = report.failures.map((failure) => ({
    kind: 'failure' as const,
    detail: `[mcp] ${failure}`,
  }))
  for (const [key, expected] of Object.entries(MCP_EXPECTED)) {
    const actual = report.observations[key]
    if (!sameValue(actual, expected)) {
      problems.push({
        kind: 'expectation',
        detail: `[mcp] '${key}' is ${render(actual)}, expected ${render(expected)}`,
      })
    }
  }
  return problems
}

interface McpSession {
  client: Client
  /** Everything the process has written to stderr so far. */
  stderr: () => string
  close: () => Promise<void>
}

/**
 * Start the executable and connect a real MCP client to it.
 *
 * `env` is passed WHOLE rather than merged over `process.env`: the executable's contract is that its
 * configuration comes from the environment, and inheriting this harness's would let a variable the
 * test never set decide the outcome. Node's own `PATH` is not needed: the command is an absolute
 * path to `node` itself.
 */
async function openSession(env: Record<string, string>): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    env,
    // Piped rather than inherited so the ready line and the "no secret leaked" rule are observable
    // instead of merely printed.
    stderr: 'pipe',
  })
  const chunks: string[] = []
  transport.stderr?.on('data', (chunk: unknown) => chunks.push(String(chunk)))
  const client = new Client({ name: 'cat-factory-sdk-smoketest', version: '0' })
  await client.connect(transport)
  return {
    client,
    stderr: () => chunks.join(''),
    close: () => client.close(),
  }
}

/** Run the executable with nothing configured and collect how it refused. */
function startUnconfigured(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    // A bare env, not a filtered one: with no CAT_FACTORY_* variable set there is nothing for the
    // server to read, which is the case a host hits on a first install.
    const child = spawn(process.execPath, [MCP_BIN], {
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('error', reject)
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

/** The text of a tool result (this facade only ever returns text content). */
function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? []
  return content.map((part) => part.text ?? '').join('\n')
}
