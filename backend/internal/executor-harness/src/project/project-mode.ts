import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { secretEnv, withAgentEnv } from '../agent.js'
import type { McpServerSpec } from '../agent-capabilities.js'
import { makeDirClaimer } from '../checkout-dir.js'
import { cloneRepo } from '../git.js'
import { extractJsonObject } from '../json-reply.js'
import { log, type Logger } from '../logger.js'
import { registerKnownSecrets } from '../redact.js'
import { runAgentInWorkspace } from '../pi-workspace.js'
import type { RunOptions } from '../runner.js'
import { resolveStructuredOutput } from '../structured-output.js'
import type { ProjectJob, ProjectResult } from './project-job.js'
import { credentialSecrets } from './access-tools.logic.js'
import { accessTools, startAccessToolsHost, type AccessToolsHost } from './access-tools-server.js'
import { ACCESS_TOOLS_TOKEN_ENV, ACCESS_TOOLS_URL_ENV } from './access-tools-proxy.js'

// The `project` job handler: an agent over a browser (Playwright MCP) and the access tool
// server, in an empty workspace holding only read-only clones of the linked services' repos.
// The credential values stay in this process (see access-tools-server.ts); the browser profile
// lives in a private directory outside the workspace, and the workspace, that directory, the
// browser and the tool server are all torn down when the job ends.

const TOOLS_PROXY = fileURLToPath(new URL('./access-tools-proxy.js', import.meta.url))
const BROWSER_START_TIMEOUT_MS = 30_000

/** The browser Playwright MCP drives and `fill_secret` reaches over CDP. */
interface ProjectBrowser {
  cdpEndpoint: string
  playwrightModule: string
  stop(): void
}

/** Where `npm install -g playwright` put the package, or undefined when it is not installed. */
async function globalPlaywrightModule(): Promise<string | undefined> {
  const root = await new Promise<string>((resolve) => {
    const child = spawn('npm', ['root', '-g'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('close', () => resolve(out.trim()))
    child.on('error', () => resolve(''))
  })
  if (!root) return undefined
  const dir = join(root, 'playwright')
  return (await readdir(dir).catch(() => null)) ? dir : undefined
}

/**
 * Start a headless Chromium with a per-job profile and remote debugging, so Playwright MCP and
 * the access tool server drive ONE browser session (a login made in one is seen by the other).
 * Undefined when the image ships no browser, which the agent is told.
 */
async function startBrowser(
  profileDir: string,
  logger: Logger,
): Promise<ProjectBrowser | undefined> {
  const playwrightModule = await globalPlaywrightModule()
  if (!playwrightModule) return undefined
  const { chromium } = (await import(pathToFileURL(join(playwrightModule, 'index.mjs')).href)) as {
    chromium: { executablePath(): string }
  }
  const child: ChildProcess = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const cdpEndpoint = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), BROWSER_START_TIMEOUT_MS)
    let seen = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      seen += chunk.toString()
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(seen)
      if (match?.[1]) {
        clearTimeout(timer)
        resolve(new URL(match[1]).origin.replace(/^ws/, 'http'))
      }
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
  if (!cdpEndpoint) {
    child.kill('SIGKILL')
    logger.warn('project: the browser did not start')
    return undefined
  }
  return { cdpEndpoint, playwrightModule, stop: () => child.kill('SIGKILL') }
}

/** Clone each linked service's repo, read-only, as a sibling directory of the workspace. */
async function cloneReferences(
  job: ProjectJob,
  workspace: string,
  opts: RunOptions,
  logger: Logger,
) {
  const claim = makeDirClaimer()
  for (const ref of job.referenceRepos ?? []) {
    const token = ref.ghToken ?? job.ghToken
    if (!token) {
      logger.warn('project: a linked repo has no token and was not cloned', {
        repo: `${ref.repo.owner}/${ref.repo.name}`,
      })
      continue
    }
    await cloneRepo({
      repo: ref.repo,
      ghToken: token,
      dir: join(workspace, claim(ref.repo)),
      signal: opts.signal,
    })
  }
}

export async function handleProject(
  job: ProjectJob,
  opts: RunOptions = {},
): Promise<ProjectResult> {
  const logger = (opts.log ?? log).child({ kind: 'project', jobId: job.jobId })
  registerKnownSecrets(credentialSecrets(job.access.credentials))
  let workspace: string | undefined
  let privateDir: string | undefined
  let browser: ProjectBrowser | undefined
  let host: AccessToolsHost | undefined
  try {
    workspace = await mkdtemp(join(tmpdir(), 'cf-project-'))
    privateDir = await mkdtemp(join(tmpdir(), 'cf-project-private-'))
    await chmod(privateDir, 0o700)
    opts.onPhase?.('clone')
    await cloneReferences(job, workspace, opts, logger)
    browser = job.access.browser
      ? await startBrowser(join(privateDir, 'profile'), logger)
      : undefined

    const tools = accessTools({
      targets: job.access.targets,
      credentials: job.access.credentials,
      ...(browser
        ? { cdpEndpoint: browser.cdpEndpoint, playwrightModule: browser.playwrightModule }
        : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    host = await startAccessToolsHost(tools.definition)
    const mcpServers: McpServerSpec[] = [
      ...(job.mcpServers ?? []),
      {
        id: 'project-access',
        transport: 'stdio',
        command: process.execPath,
        args: [TOOLS_PROXY],
        env: { [ACCESS_TOOLS_URL_ENV]: host.url, [ACCESS_TOOLS_TOKEN_ENV]: host.token },
      },
      ...(browser
        ? [
            {
              id: 'browser',
              transport: 'stdio' as const,
              command: 'playwright-mcp',
              args: [
                '--cdp-endpoint',
                browser.cdpEndpoint,
                '--output-dir',
                join(privateDir, 'browser'),
                '--image-responses',
                'omit',
              ],
            },
          ]
        : []),
    ]
    const browserNote =
      job.access.browser && !browser
        ? '\n\nNote: no browser is available to this run, so no target can be used through its ' +
          'UI. Do what the APIs allow and say in your answer what needed a UI.'
        : ''

    opts.onPhase?.('agent')
    const run = await runAgentInWorkspace(
      {
        dir: workspace,
        systemPrompt: job.systemPrompt,
        userPrompt: `${job.userPrompt}${browserNote}`,
        model: job.model,
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        ambientAuth: job.ambientAuth,
        proxyBaseUrl: job.proxyBaseUrl,
        proxyPhasePath: job.proxyPhasePath,
        sessionToken: job.sessionToken,
        expectsEdits: false,
        ...(job.contextFiles ? { contextFiles: job.contextFiles } : {}),
        ...(job.guardLimits ? { guardLimits: job.guardLimits } : {}),
        mcpServers,
        ...(job.referenceRepos?.length ? { multiRepo: true } : {}),
      },
      withAgentEnv(opts, secretEnv(job.capabilitySecrets)),
    )

    const { needsCredential: request, httpExchanges } = tools.recorded()
    const common = {
      summary: run.summary,
      stats: run.stats,
      ...(run.usage ? { usage: run.usage } : {}),
      ...(run.callMetrics ? { callMetrics: run.callMetrics } : {}),
      ...(request ? { needsCredential: request } : {}),
      ...(httpExchanges.length ? { httpExchanges } : {}),
    }
    if (!run.summary.trim()) {
      return {
        ...common,
        error: 'the project agent returned no answer',
        failureCause: 'no-usable-output',
      }
    }
    const resolved = await resolveStructuredOutput(
      {
        label: 'project',
        shapeHint: job.output?.shapeHint ?? 'Expected a single JSON object.',
        parse: (text) => extractJsonObject(text),
      },
      run.summary,
      {
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        proxyBaseUrl: job.proxyBaseUrl,
        proxyPhasePath: job.proxyPhasePath,
        sessionToken: job.sessionToken,
        model: job.model,
        jobId: job.jobId,
        signal: opts.signal,
      },
    )
    if (resolved.value === undefined || resolved.value === null) {
      return {
        ...common,
        error: 'the project agent returned no readable result',
        failureCause: 'no-usable-output',
      }
    }
    logger.info('project: done', {
      exchanges: httpExchanges.length,
      waiting: Boolean(request),
    })
    return { ...common, custom: resolved.value }
  } finally {
    browser?.stop()
    await host?.close()
    if (privateDir) await rm(privateDir, { recursive: true, force: true }).catch(() => {})
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
}
