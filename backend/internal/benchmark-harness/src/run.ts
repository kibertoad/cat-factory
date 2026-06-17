import { performance } from 'node:perf_hooks'
import { DEFAULT_SPEND_PRICING, estimateCost } from '@cat-factory/spend'
import type { ModelProvider, ModelRef } from '@cat-factory/kernel'
import { requirementsLogic } from '@cat-factory/orchestration'
import { type BenchmarkConfig, TASK_PROMPT_ID } from './config'
import { resolvePiEndpoint } from './endpoints'
import {
  CODE_REVIEW_FIXTURES,
  type CodeReviewFixture,
  IMPLEMENTATION_FIXTURES,
  type ImplementationFixture,
  REQUIREMENT_REVIEW_FIXTURES,
  type RequirementReviewFixture,
} from './fixtures'
import { NodeModelProvider } from './model-provider'
import { resolvePromptVariant } from './prompt-registry'
import { runCodeReview } from './runners/codeReview'
import { runImplementation } from './runners/implementation'
import { runRequirementReview } from './runners/requirementReview'
import type { RunnerDeps, RunnerOutput } from './runners/types'
import {
  type CandidateResult,
  type CellKey,
  cellId,
  type PromptVariant,
  type TaskType,
} from './types'

export interface RunOptions {
  config: BenchmarkConfig
  env?: NodeJS.ProcessEnv
  /** Inject a model provider (defaults to a NodeModelProvider over `env`). */
  provider?: ModelProvider
  log?: (msg: string) => void
  signal?: AbortSignal
}

function variantsFor(config: BenchmarkConfig, task: TaskType): PromptVariant[] {
  const declared = config.prompts?.[task]
  if (declared && declared.length) return declared
  return [{ promptId: TASK_PROMPT_ID[task] }]
}

function fixtureFilter(config: BenchmarkConfig, task: TaskType): (id: string) => boolean {
  const ids = config.fixtures?.[task]
  return ids && ids.length ? (id: string) => ids.includes(id) : () => true
}

function cost(ref: ModelRef, usage: RunnerOutput['usage']): number | undefined {
  return usage ? estimateCost(DEFAULT_SPEND_PRICING, ref, usage) : undefined
}

/**
 * Run the whole matrix. For each task × fixture × model × prompt-variant cell it
 * runs the real cat-factory agent (reused from core / the executor harness)
 * and records the candidate output with its exact model and prompt version. The
 * outputs are graded later by the Claude arbiter skill.
 */
export async function runBenchmark(opts: RunOptions): Promise<CandidateResult[]> {
  const env = opts.env ?? process.env
  const log = opts.log ?? (() => {})
  const provider = opts.provider ?? new NodeModelProvider({ env })
  const deps: RunnerDeps = { provider, env, signal: opts.signal }
  const tasks =
    opts.config.tasks ?? (['requirement-review', 'code-review', 'implementation'] as TaskType[])
  const results: CandidateResult[] = []

  for (const task of tasks) {
    const accept = fixtureFilter(opts.config, task)
    const variants = variantsFor(opts.config, task).map(resolvePromptVariant)

    for (const candidate of opts.config.models) {
      const ref = candidate.ref
      const modelLabel = candidate.label ?? `${ref.provider}:${ref.model}`
      const modelId = `${ref.provider}:${ref.model}`

      for (const prompt of variants) {
        const runOne = async (
          fixtureId: string,
          input: string,
          run: () => Promise<RunnerOutput>,
        ) => {
          const cell: CellKey = {
            task,
            fixtureId,
            modelLabel,
            model: modelId,
            prompt: prompt.label,
            variant: prompt.label,
          }
          const id = cellId(cell)
          log(`▶ ${id}`)
          const start = performance.now()
          try {
            const out = await run()
            results.push({
              id,
              cell,
              input,
              output: out.output,
              latencyMs: Math.round(performance.now() - start),
              usage: out.usage,
              costEur: cost(ref, out.usage),
              meta: out.meta,
            })
          } catch (err) {
            results.push({
              id,
              cell,
              input,
              output: '',
              latencyMs: Math.round(performance.now() - start),
              error: err instanceof Error ? err.message : String(err),
            })
            log(`  ✗ ${id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        if (task === 'requirement-review') {
          for (const fx of REQUIREMENT_REVIEW_FIXTURES.filter((f) => accept(f.id))) {
            await runOne(fx.id, requirementsLogic.renderRequirements(fx.context), () =>
              runRequirementReview({
                fixture: fx as RequirementReviewFixture,
                modelRef: ref,
                prompt,
                deps,
              }),
            )
          }
        } else if (task === 'code-review') {
          for (const fx of CODE_REVIEW_FIXTURES.filter((f) => accept(f.id))) {
            const input = fx.context.priorOutputs.map((p) => p.output).join('\n\n')
            await runOne(fx.id, input, () =>
              runCodeReview({ fixture: fx as CodeReviewFixture, modelRef: ref, prompt, deps }),
            )
          }
        } else {
          for (const fx of IMPLEMENTATION_FIXTURES.filter((f) => accept(f.id))) {
            const endpoint = resolvePiEndpoint(ref, candidate.endpoint, env)
            const input = `Repo: ${fx.repo.owner}/${fx.repo.name}@${fx.repo.baseBranch}\nTask: ${fx.task}`
            await runOne(fx.id, input, () =>
              runImplementation({
                fixture: fx as ImplementationFixture,
                modelRef: ref,
                prompt,
                endpoint,
                deps,
              }),
            )
          }
        }
      }
    }
  }
  return results
}
