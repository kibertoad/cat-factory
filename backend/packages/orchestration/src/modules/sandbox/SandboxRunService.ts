import type {
  Clock,
  IdGenerator,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  SandboxExperiment,
  SandboxExperimentRepository,
  SandboxFixture,
  SandboxFixtureRepository,
  SandboxGrade,
  SandboxGradeRepository,
  SandboxPromptVersionRepository,
  SandboxRun,
  SandboxRunRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  inlineModelRef,
  requireWorkspace,
  ValidationError,
} from '@cat-factory/kernel'
import { catFactoryObservability } from '@cat-factory/agents'
import { SANDBOX_REPO_FIXTURE_KINDS } from '@cat-factory/contracts'
import {
  expandMatrix,
  listBaselines,
  listBuiltinFixtures,
  rubricFor,
  sandboxKindMeta,
  versionLabel,
  weightedTotal,
} from '@cat-factory/sandbox'
import { generateText } from 'ai'
import type { SandboxExperimentDetail } from './SandboxService.js'
import {
  buildJudgePrompt,
  coerceJudgeScores,
  extractJson,
  JUDGE_SYSTEM_PROMPT,
  objectiveFor,
  parseModelCatalogId,
  renderFixtureInput,
} from './sandbox.logic.js'

export interface SandboxRunServiceDependencies {
  sandboxPromptVersionRepository: SandboxPromptVersionRepository
  sandboxFixtureRepository: SandboxFixtureRepository
  sandboxExperimentRepository: SandboxExperimentRepository
  sandboxRunRepository: SandboxRunRepository
  sandboxGradeRepository: SandboxGradeRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
  /** Per-scope model provider (the DB-backed key pool). Preferred over the static one. */
  modelProviderResolver?: ModelProviderResolver
  /** Static model provider (e.g. a fake in tests / conformance). */
  modelProvider?: ModelProvider
  /** Resolve a model catalog id to a deployment-aware {@link ModelRef}. */
  resolveModelId?: (modelId: string | undefined) => ModelRef | undefined
  /** Routing default ref, used to degrade subscription models for these inline calls. */
  defaultModelRef?: ModelRef
}

/** Per-cell resolved prompt (the system text under test + its frozen label). */
interface ResolvedPrompt {
  systemText: string
  label: string
}

/**
 * The Sandbox run-driver + judge. {@link launch} expands a draft experiment's matrix
 * into cells, runs each inline candidate (one LLM call against the prompt-version's
 * system text + the fixture's rendered input), grades it with the judge model against
 * the task rubric, and records the deterministic objective score alongside. It drives
 * synchronously to completion (bounded by a cell cap at create time + an optional token
 * budget) — every cell is a single inline LLM call, so there is no durable fan-out.
 *
 * Container/repo fixtures (a real checkout) are not yet supported here and are refused at
 * launch with a clear message; the builtin fixtures are all inline. Both runtimes wire
 * this identically, so the refusal — like the run itself — is runtime-symmetric.
 */
export class SandboxRunService {
  constructor(private readonly deps: SandboxRunServiceDependencies) {}

  async launch(workspaceId: string, experimentId: string): Promise<SandboxExperimentDetail> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const experiment = assertFound(
      await this.deps.sandboxExperimentRepository.get(workspaceId, experimentId),
      'SandboxExperiment',
      experimentId,
    )
    if (experiment.status === 'running') {
      throw new ConflictError('This experiment is already running.')
    }
    const meta = sandboxKindMeta(experiment.agentKind)
    if (!meta) throw new ValidationError(`"${experiment.agentKind}" is not a Sandbox-testable kind`)
    if (meta.bucket === 'container') {
      throw new ValidationError(
        `The "${experiment.agentKind}" agent runs in a container; container experiments are not yet supported in the Sandbox.`,
      )
    }

    const provider = await this.providerFor(workspaceId)
    const prompts = await this.resolvePrompts(workspaceId, experiment)
    const fixtures = await this.resolveFixtures(workspaceId, experiment)
    const rubric = rubricFor(meta.rubric)

    // A relaunch re-runs from scratch: drop the prior result grid (grades before runs, so
    // the grade scoping subquery still resolves the cells) so cells don't accumulate.
    await this.deps.sandboxGradeRepository.removeByExperiment(workspaceId, experimentId)
    await this.deps.sandboxRunRepository.removeByExperiment(workspaceId, experimentId)

    // Persist the queued grid first, then drive each cell.
    const now = this.deps.clock.now()
    const runs = expandMatrix(experiment, {
      makeId: () => this.deps.idGenerator.next('sbr'),
      labelFor: (id) => prompts.get(id)?.label ?? id,
      now,
    })
    for (const run of runs) await this.deps.sandboxRunRepository.upsert(workspaceId, run)
    await this.deps.sandboxExperimentRepository.setStatus(workspaceId, experimentId, 'running')

    // Drive every cell synchronously to completion. The terminal status is derived from
    // the cell outcomes and ALWAYS settled in `finally` — a thrown error (or every cell
    // failing) leaves the experiment `failed`, never stuck `running`. NOTE: this runs the
    // whole matrix inline in the request; the cell cap + token budget bound it, but a true
    // durable fan-out (Workflows / pg-boss, like execution+bootstrap) is the proper home
    // for large matrices and the tracked follow-up.
    const budget = experiment.budgetTokens
    let spent = 0
    let succeeded = 0
    try {
      for (const run of runs) {
        if (budget !== null && spent >= budget) {
          await this.failRun(workspaceId, run, 'Token budget exhausted before this cell ran.')
          continue
        }
        try {
          const prompt = prompts.get(run.promptVersionId)
          const fixture = fixtures.get(run.fixtureId)
          if (!prompt) throw new ValidationError(`Unknown prompt version "${run.promptVersionId}"`)
          if (!fixture) throw new ValidationError(`Unknown fixture "${run.fixtureId}"`)

          const taskInput = renderFixtureInput(fixture)
          const candidateRef = this.refFor(run.model)
          const started = this.deps.clock.now()
          const candidate = await generateText({
            model: provider.resolve(candidateRef),
            system: prompt.systemText,
            prompt: taskInput,
            temperature: 0.2,
            maxOutputTokens: 4000,
            providerOptions: catFactoryObservability({
              agentKind: `sandbox:${experiment.agentKind}`,
              workspaceId,
            }),
          })
          const latencyMs = this.deps.clock.now() - started
          const usage = {
            inputTokens: candidate.usage.inputTokens ?? 0,
            outputTokens: candidate.usage.outputTokens ?? 0,
          }
          spent += usage.inputTokens + usage.outputTokens

          const done: SandboxRun = {
            ...run,
            status: 'done',
            outputText: candidate.text,
            usage,
            latencyMs,
            startedAt: started,
            finishedAt: this.deps.clock.now(),
          }
          await this.deps.sandboxRunRepository.upsert(workspaceId, done)

          // Grade the cell (rubric + objective) and persist it.
          const judgeRef = this.refFor(experiment.judgeModel)
          const judged = await generateText({
            model: provider.resolve(judgeRef),
            system: JUDGE_SYSTEM_PROMPT,
            prompt: buildJudgePrompt(rubric, taskInput, candidate.text, expectationsOf(fixture)),
            temperature: 0,
            maxOutputTokens: 2000,
            providerOptions: catFactoryObservability({ agentKind: 'sandbox:judge', workspaceId }),
          })
          spent += (judged.usage.inputTokens ?? 0) + (judged.usage.outputTokens ?? 0)
          const scores = coerceJudgeScores(rubric, extractJson(judged.text))
          const grade: SandboxGrade = {
            id: this.deps.idGenerator.next('sbg'),
            runId: run.id,
            judgeModel: experiment.judgeModel,
            scores,
            weightedTotal: weightedTotal(meta.rubric, scores),
            objective: objectiveFor(fixture, candidate.text),
            createdAt: this.deps.clock.now(),
          }
          await this.deps.sandboxGradeRepository.upsert(workspaceId, grade)
          succeeded++
        } catch (e) {
          await this.failRun(workspaceId, run, e instanceof Error ? e.message : String(e))
        }
      }
    } finally {
      // Settle the terminal status from the outcomes: any successful cell → `done`,
      // otherwise `failed`. This always runs, so the experiment is never left `running`.
      await this.deps.sandboxExperimentRepository.setStatus(
        workspaceId,
        experimentId,
        succeeded > 0 ? 'done' : 'failed',
      )
    }
    return this.detail(workspaceId, experimentId)
  }

  // ---- internals ------------------------------------------------------------

  private async failRun(workspaceId: string, run: SandboxRun, error: string): Promise<void> {
    await this.deps.sandboxRunRepository.upsert(workspaceId, {
      ...run,
      status: 'failed',
      error,
      finishedAt: this.deps.clock.now(),
    })
  }

  /** Resolve every prompt version referenced by the matrix to its system text + label. */
  private async resolvePrompts(
    workspaceId: string,
    experiment: SandboxExperiment,
  ): Promise<Map<string, ResolvedPrompt>> {
    const baselines = listBaselines(this.deps.clock.now())
    const map = new Map<string, ResolvedPrompt>()
    for (const id of new Set(experiment.matrix.promptVersionIds)) {
      if (id.startsWith('baseline:')) {
        const baseline = baselines.find((b) => b.id === id)
        if (!baseline) throw new ValidationError(`Unknown baseline prompt "${id}"`)
        map.set(id, { systemText: baseline.systemText, label: baseline.name })
      } else {
        const version = assertFound(
          await this.deps.sandboxPromptVersionRepository.get(workspaceId, id),
          'SandboxPromptVersion',
          id,
        )
        map.set(id, { systemText: version.systemText, label: versionLabel(version) })
      }
    }
    return map
  }

  /** Resolve every fixture referenced by the matrix (stored, else builtin), refusing repo fixtures. */
  private async resolveFixtures(
    workspaceId: string,
    experiment: SandboxExperiment,
  ): Promise<Map<string, SandboxFixture>> {
    const builtins = new Map(listBuiltinFixtures(this.deps.clock.now()).map((f) => [f.id, f]))
    const map = new Map<string, SandboxFixture>()
    for (const id of new Set(experiment.matrix.fixtureIds)) {
      const fixture =
        (await this.deps.sandboxFixtureRepository.get(workspaceId, id)) ?? builtins.get(id)
      if (!fixture) throw new ValidationError(`Unknown fixture "${id}"`)
      if ((SANDBOX_REPO_FIXTURE_KINDS as readonly string[]).includes(fixture.kind)) {
        throw new ValidationError(
          `Fixture "${fixture.name}" needs a repository checkout; repo fixtures are not yet supported in the Sandbox.`,
        )
      }
      map.set(id, fixture)
    }
    return map
  }

  /** The model provider for a workspace's scope (per-scope DB pool, else the static one). */
  private async providerFor(workspaceId: string): Promise<ModelProvider> {
    const provider = this.deps.modelProviderResolver
      ? await this.deps.modelProviderResolver.forScope({ workspaceId })
      : this.deps.modelProvider
    if (!provider) throw new ValidationError('No model provider is configured for the Sandbox')
    return provider
  }

  /** A catalog id → inline-servable {@link ModelRef} (subscription models degrade to the default). */
  private refFor(modelId: string): ModelRef {
    const resolved = this.deps.resolveModelId?.(modelId) ?? parseModelCatalogId(modelId)
    return inlineModelRef(resolved, this.deps.defaultModelRef ?? resolved)
  }

  private async detail(
    workspaceId: string,
    experimentId: string,
  ): Promise<SandboxExperimentDetail> {
    const experiment = assertFound(
      await this.deps.sandboxExperimentRepository.get(workspaceId, experimentId),
      'SandboxExperiment',
      experimentId,
    )
    const [runs, grades] = await Promise.all([
      this.deps.sandboxRunRepository.listByExperiment(workspaceId, experimentId),
      this.deps.sandboxGradeRepository.listByExperiment(workspaceId, experimentId),
    ])
    return { experiment, runs, grades }
  }
}

function expectationsOf(fixture: SandboxFixture) {
  return fixture.objective?.kind === 'findings' ? fixture.objective.expectations : []
}
