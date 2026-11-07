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
import type { ResearchJob, ResearchResult } from './research-job.js'
import { credentialSecrets } from './research-tools.logic.js'
import {
  researchTools,
  startResearchToolsHost,
  type ResearchToolsHost,
} from './research-tools-server.js'
import { RESEARCH_TOOLS_TOKEN_ENV, RESEARCH_TOOLS_URL_ENV } from './research-tools-proxy.js'

// The `research` job handler: an agent over a browser (Playwright MCP) and the research tool
// server, in an empty workspace holding only read-only clones of the linked services' repos.
// The credential values stay in this process (see research-tools-server.ts); the browser profile
// lives in a private directory outside the workspace, and the workspace, that directory, the
// browser and the tool server are all torn down when the job ends.

const TOOLS_PROXY = fileURLToPath(new URL('./research-tools-proxy.js', import.meta.url))
const BROWSER_START_TIMEOUT_MS = 30_000

/** The browser Playwright MCP drives and `fill_secret` reaches over CDP. */
interface ResearchBrowser {
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
 * the research tool server drive ONE browser session (a login made in one is seen by the other).
 * Undefined when the image ships no browser, which the agent is told.
 */
async function startBrowser(
  profileDir: string,
  logger: Logger,
): Promise<ResearchBrowser | undefined> {
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
    logger.warn('research: the browser did not start')
    return undefined
  }
  return { cdpEndpoint, playwrightModule, stop: () => child.kill('SIGKILL') }
}

/** Clone each linked service's repo, read-only, as a sibling directory of the workspace. */
async function cloneReferences(
  job: ResearchJob,
  workspace: string,
  opts: RunOptions,
  logger: Logger,
) {
  const claim = makeDirClaimer()
  for (const ref of job.referenceRepos ?? []) {
    const token = ref.ghToken ?? job.ghToken
    if (!token) {
      logger.warn('research: a linked repo has no token and was not cloned', {
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

export async function handleResearch(
  job: ResearchJob,
  opts: RunOptions = {},
): Promise<ResearchResult> {
  const logger = (opts.log ?? log).child({ kind: 'research', jobId: job.jobId })
  registerKnownSecrets(credentialSecrets(job.research.credentials))
  let workspace: string | undefined
  let privateDir: string | undefined
  let browser: ResearchBrowser | undefined
  let host: ResearchToolsHost | undefined
  try {
    workspace = await mkdtemp(join(tmpdir(), 'cf-research-'))
    privateDir = await mkdtemp(join(tmpdir(), 'cf-research-private-'))
    await chmod(privateDir, 0o700)
    opts.onPhase?.('clone')
    await cloneReferences(job, workspace, opts, logger)
    browser = job.research.browser
      ? await startBrowser(join(privateDir, 'profile'), logger)
      : undefined

    const tools = researchTools({
      targets: job.research.targets,
      credentials: job.research.credentials,
      ...(browser
        ? { cdpEndpoint: browser.cdpEndpoint, playwrightModule: browser.playwrightModule }
        : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    host = await startResearchToolsHost(tools.definition)
    const mcpServers: McpServerSpec[] = [
      ...(job.mcpServers ?? []),
      {
        id: 'research',
        transport: 'stdio',
        command: process.execPath,
        args: [TOOLS_PROXY],
        env: { [RESEARCH_TOOLS_URL_ENV]: host.url, [RESEARCH_TOOLS_TOKEN_ENV]: host.token },
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
      job.research.browser && !browser
        ? '\n\nNote: no browser is available to this run, so the vendor UI cannot be explored. ' +
          'Answer what the API allows and mark UI-only questions as unanswered.'
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
        error: 'the research agent returned no answer',
        failureCause: 'no-usable-output',
      }
    }
    const resolved = await resolveStructuredOutput(
      {
        label: 'research',
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
        error: 'the research agent returned no readable findings',
        failureCause: 'no-usable-output',
      }
    }
    logger.info('research: done', {
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
