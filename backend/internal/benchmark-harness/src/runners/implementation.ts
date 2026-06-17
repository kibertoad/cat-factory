import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  cloneRepo,
  runPi,
  writeAgentsContext,
  writePiModelsConfig,
} from '@cat-factory/executor-harness/embed'
import type { ImplementationFixture } from '../fixtures'
import type { RunnerInput, RunnerOutput } from './types'

const exec = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

// Implementation candidate: the *real* Pi coding flow, reused from the
// executor harness but run locally — clone the repo, write the build system
// prompt as AGENTS.md, point Pi at the chosen OpenAI-compatible endpoint
// (a direct provider or Cloudflare Workers AI), run it, and capture the diff.
// Requires the `pi` CLI on PATH; throws a clear error otherwise.

export async function runImplementation(
  input: RunnerInput<ImplementationFixture>,
): Promise<RunnerOutput> {
  const { fixture, prompt, deps, modelRef, endpoint } = input
  if (!endpoint) throw new Error('implementation runner requires a resolved Pi endpoint')
  const sessionToken = deps.env[endpoint.keyEnv]
  if (!sessionToken) {
    throw new Error(`${endpoint.keyEnv} is not set (needed as the Pi endpoint bearer key)`)
  }

  const dir = await mkdtemp(join(tmpdir(), 'cat-bench-impl-'))
  try {
    await cloneRepo({
      repo: fixture.repo,
      ghToken: deps.env.GH_TOKEN ?? '',
      dir,
      signal: deps.signal,
    })
    await writeAgentsContext(dir, prompt.system)
    await writePiModelsConfig({ model: modelRef.model, proxyBaseUrl: endpoint.baseUrl })

    const userPrompt = [
      `Block: ${fixture.block.title} (${fixture.block.type})`,
      `Description: ${fixture.block.description}`,
      '',
      `Task: ${fixture.task}`,
      '',
      'Implement this directly in the working tree. Do not open a pull request.',
    ].join('\n')

    const outcome = await runPi({
      cwd: dir,
      model: modelRef.model,
      userPrompt,
      sessionToken,
      signal: deps.signal,
    })

    await git(['add', '-A'], dir)
    const diff = await git(['diff', '--cached', '--', '.', ':(exclude)AGENTS.md'], dir)
    const truncated = diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n... (diff truncated)` : diff

    return {
      output: truncated.trim() || '(no changes produced)',
      meta: {
        summary: outcome.summary,
        stats: outcome.stats,
        diffBytes: diff.length,
        ...(outcome.stderrTail ? { stderrTail: outcome.stderrTail } : {}),
      },
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
