import type { SmoketestConfig } from './config'
import { type RunCaseOutput, runCase } from './case'
import { type ImplementationFixture, SMOKETEST_FIXTURES } from './fixtures'

// Expands the smoketest matrix (fixture × model) and runs each case through the
// real Pi setup. Cases run sequentially on purpose: each spawns a `pi` process
// and swaps `$HOME` to a throwaway dir for its run, so running them in parallel
// would race on the process-wide env.

export interface RunOptions {
  config: SmoketestConfig
  env?: NodeJS.ProcessEnv
  log?: (msg: string) => void
  signal?: AbortSignal
}

function selectedFixtures(config: SmoketestConfig): ImplementationFixture[] {
  const ids = config.fixtures
  if (!ids || !ids.length) return SMOKETEST_FIXTURES
  const known = new Map(SMOKETEST_FIXTURES.map((f) => [f.id, f]))
  return ids.map((id) => {
    const fx = known.get(id)
    if (!fx) throw new Error(`Unknown fixture id '${id}'. Known: ${[...known.keys()].join(', ')}`)
    return fx
  })
}

/** Run the whole matrix; returns the per-case captured output (result + raw transcript). */
export async function runSmoketests(opts: RunOptions): Promise<RunCaseOutput[]> {
  const env = opts.env ?? process.env
  const log = opts.log ?? (() => {})
  const fixtures = selectedFixtures(opts.config)
  const outputs: RunCaseOutput[] = []

  for (const candidate of opts.config.models) {
    const modelLabel = candidate.label ?? `${candidate.ref.provider}:${candidate.ref.model}`
    for (const fixture of fixtures) {
      log(`▶ ${fixture.id} · ${modelLabel}`)
      try {
        const output = await runCase({
          fixture,
          candidate,
          env,
          signal: opts.signal,
          relaxGuard: opts.config.relaxGuard,
        })
        const { verdict, findings } = output.result
        const worst = findings.find((f) => f.severity === 'error') ?? findings[0]
        log(`  ${verdictMark(verdict)} ${verdict}${worst ? ` — ${worst.message}` : ''}`)
        outputs.push(output)
      } catch (err) {
        // A throw here (e.g. a missing endpoint key) is a harness-setup problem,
        // not a model finding — surface it loudly and keep going.
        log(`  ✗ setup error: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
    }
  }
  return outputs
}

function verdictMark(verdict: string): string {
  return verdict === 'healthy' ? '✓' : verdict === 'degraded' ? '◐' : '✗'
}
