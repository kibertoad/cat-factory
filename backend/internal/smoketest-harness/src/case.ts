import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import {
  defaultVariant,
  type ImplementationFixture,
  type ModelCandidate,
  resolvePiEndpoint,
  resolvePromptVariant,
} from '@cat-factory/benchmark-harness'
import {
  cloneRepo,
  type ProgressGuardLimits,
  runPi,
  writeAgentsContext,
  writePiModelsConfig,
} from '@cat-factory/executor-harness/embed'
import { analyzeCase } from './analyze'
import type { PiEvent, SmoketestCaseResult } from './types'

// Runs ONE smoketest case end to end through the *real* Pi setup — the same flow
// the benchmark harness's implementation runner uses (clone → write the build
// system prompt as Pi's global AGENTS.md → point Pi at the OpenAI-compatible
// endpoint, here Cloudflare Workers AI → run) — but it taps `runPi`'s `onEvent`
// to capture the entire prompt/response/tool-call transcript, captures the diff,
// and hands both to the analyser. Nothing is graded.

const exec = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

export interface RunCaseOptions {
  fixture: ImplementationFixture
  candidate: ModelCandidate
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  /**
   * Relax the live no-progress guard so a loop runs to completion and the whole
   * thing is captured for analysis, instead of Pi being killed at the guard's
   * threshold. Off by default (faithful to the real harness, which keeps the guard).
   */
  relaxGuard?: boolean
}

/** Effectively-unbounded guard limits, used when `relaxGuard` is set. */
const RELAXED_GUARD: ProgressGuardLimits = {
  maxToolCallsWithoutEdit: Number.MAX_SAFE_INTEGER,
  maxConsecutiveErrors: Number.MAX_SAFE_INTEGER,
  maxConsecutiveWebCalls: Number.MAX_SAFE_INTEGER,
}

/** The full captured run for one case (the result + the raw events for artifacts). */
export interface RunCaseOutput {
  result: SmoketestCaseResult
  /** Every Pi event captured, in stream order — the raw transcript. */
  events: PiEvent[]
  /** The resolved system + user prompt the agent was given. */
  prompts: { system: string; user: string }
  /** The staged diff the run produced (may be empty). */
  diff: string
}

export async function runCase(opts: RunCaseOptions): Promise<RunCaseOutput> {
  const { fixture, candidate, env } = opts
  const ref = candidate.ref
  const modelLabel = candidate.label ?? `${ref.provider}:${ref.model}`
  const modelId = `${ref.provider}:${ref.model}`
  const id = caseId(fixture.id, modelLabel)

  const endpoint = resolvePiEndpoint(ref, candidate.endpoint, env)
  const sessionToken = env[endpoint.keyEnv]
  if (!sessionToken) {
    throw new Error(`${endpoint.keyEnv} is not set (needed as the Pi endpoint bearer key)`)
  }

  const system = resolvePromptVariant(defaultVariant('build')).system
  const user = userPrompt(fixture)

  const events: PiEvent[] = []
  let diff = ''
  let error: string | undefined
  let filesChanged = 0

  // Like the benchmark harness: writeAgentsContext / writePiModelsConfig write Pi's
  // GLOBAL config under $HOME/.pi/agent, and `pi` reads it from there. Point both at
  // a throwaway HOME for the run so we never clobber the developer's own ~/.pi/agent.
  const dir = await mkdtemp(join(tmpdir(), 'cat-smoke-repo-'))
  const piHome = await mkdtemp(join(tmpdir(), 'cat-smoke-pihome-'))
  const realHome = process.env.HOME
  const start = performance.now()
  try {
    await cloneRepo({
      repo: fixture.repo,
      ghToken: env.GH_TOKEN ?? '',
      dir,
      signal: opts.signal,
    })
    process.env.HOME = piHome
    await writeAgentsContext(system)
    await writePiModelsConfig({ model: ref.model, proxyBaseUrl: endpoint.baseUrl })

    try {
      await runPi({
        cwd: dir,
        model: ref.model,
        userPrompt: user,
        sessionToken,
        signal: opts.signal,
        onEvent: (event) => events.push(event),
        ...(opts.relaxGuard ? { guardLimits: RELAXED_GUARD } : {}),
      })
    } catch (err) {
      // A guard abort / terminal model error / spawn failure is itself a finding —
      // capture it and analyse what we got, don't abort the whole smoketest.
      error = err instanceof Error ? err.message : String(err)
    }

    // Capture whatever the run changed, even on a guard-killed / failed run — a
    // partial diff is still signal.
    try {
      await git(['add', '-A'], dir)
      diff = await git(['diff', '--cached', '--', '.'], dir)
      const names = (await git(['diff', '--cached', '--name-only'], dir)).trim()
      filesChanged = names ? names.split('\n').length : 0
    } catch {
      // Clone may have failed before a working tree existed; leave diff empty.
    }
  } finally {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    await rm(dir, { recursive: true, force: true })
    await rm(piHome, { recursive: true, force: true })
  }

  const durationMs = Math.round(performance.now() - start)
  const analysis = analyzeCase({
    events,
    error,
    durationMs,
    diffBytes: Buffer.byteLength(diff),
    filesChanged,
    expectsEdits: true,
  })

  const result: SmoketestCaseResult = {
    id,
    fixtureId: fixture.id,
    fixtureTitle: fixture.title,
    model: modelId,
    modelLabel,
    task: fixture.task,
    verdict: analysis.verdict,
    findings: analysis.findings,
    metrics: analysis.metrics,
    summary: analysis.summary,
    error,
  }

  return { result, events, prompts: { system, user }, diff }
}

/** The concrete instruction handed to Pi — block context + the coding task. */
export function userPrompt(fixture: ImplementationFixture): string {
  return [
    `Block: ${fixture.block.title} (${fixture.block.type})`,
    `Description: ${fixture.block.description}`,
    '',
    `Task: ${fixture.task}`,
    '',
    'Implement this directly in the working tree. Do not open a pull request.',
  ].join('\n')
}

/** Filesystem-safe id for a case — also its artifact basename. */
export function caseId(fixtureId: string, modelLabel: string): string {
  return [fixtureId, modelLabel].map((p) => p.replace(/[^a-zA-Z0-9._-]+/g, '-')).join('__')
}
