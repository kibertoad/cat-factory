import type {
  AgentPromptRepository,
  Clock,
  IdGenerator,
  ModelRef,
  SandboxExperiment,
  SandboxExperimentRepository,
  SandboxFixture,
  SandboxFixtureRepository,
  SandboxGrade,
  SandboxGradeRepository,
  SandboxPromptVersion,
  SandboxPromptVersionRepository,
  SandboxRun,
  SandboxRunRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { assertFound, ConflictError, requireWorkspace, ValidationError } from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type {
  CreateSandboxExperimentInput,
  CreateSandboxFixtureInput,
  CloneSandboxPromptInput,
  SaveSandboxVersionInput,
  SetSandboxLabelsInput,
} from '@cat-factory/contracts'
import {
  cellCount,
  firstVersionFromBaseline,
  isRunnableMatrix,
  listBaselines,
  listBuiltinFixtures,
  nextVersion,
  SANDBOX_AGENT_KINDS,
  type SandboxAgentKindMeta,
  baselineVersionId,
  sandboxKindMeta,
  sandboxPromptKinds,
  workspacePromptVersions,
} from '@cat-factory/sandbox'
import { assertSandboxRunnable, assertSandboxRunnableFixture } from './sandboxAdmission.js'

/** A safety ceiling on how many cells one experiment may expand to (cost guard). */
export const MAX_SANDBOX_CELLS = 100

/** The composed experiment view: the experiment plus its result grid (cells + grades). */
export interface SandboxExperimentDetail {
  experiment: SandboxExperiment
  runs: SandboxRun[]
  grades: SandboxGrade[]
}

/** The three repositories needed to compose an {@link SandboxExperimentDetail}. */
export interface SandboxDetailRepositories {
  sandboxExperimentRepository: SandboxExperimentRepository
  sandboxRunRepository: SandboxRunRepository
  sandboxGradeRepository: SandboxGradeRepository
}

/**
 * Load an experiment and its result grid (cells + grades). Shared by the read endpoint
 * (`SandboxService.getExperiment`) and the run-driver's returned grid
 * (`SandboxRunService.launch`) so the two can never compose a divergent detail shape.
 */
export async function composeExperimentDetail(
  repos: SandboxDetailRepositories,
  workspaceId: string,
  experimentId: string,
): Promise<SandboxExperimentDetail> {
  const experiment = assertFound(
    await repos.sandboxExperimentRepository.get(workspaceId, experimentId),
    'SandboxExperiment',
    experimentId,
  )
  const [runs, grades] = await Promise.all([
    repos.sandboxRunRepository.listByExperiment(workspaceId, experimentId),
    repos.sandboxGradeRepository.listByExperiment(workspaceId, experimentId),
  ])
  return { experiment, runs, grades }
}

/** The opt-in Sandbox overview the management surface loads on open. */
export interface SandboxOverview {
  agentKinds: readonly SandboxAgentKindMeta[]
  prompts: SandboxPromptVersion[]
  fixtures: SandboxFixture[]
  experiments: SandboxExperiment[]
  /**
   * The matrix cell cap (the cost guard {@link MAX_SANDBOX_CELLS} enforced at create). Surfaced
   * so the UI gates the builder on the SAME limit instead of re-encoding the literal, which
   * would silently disagree if the cap ever changes.
   */
  maxCells: number
}

export interface SandboxServiceDependencies {
  sandboxPromptVersionRepository: SandboxPromptVersionRepository
  /**
   * Optional: the workspace's agent-prompt override log, so the browser can offer the prompts the
   * workspace is ACTUALLY running beside the shipped baselines. Absent (the feature unwired) ⇒
   * baselines and stored candidates only, exactly as before.
   */
  agentPromptRepository?: AgentPromptRepository
  sandboxFixtureRepository: SandboxFixtureRepository
  sandboxExperimentRepository: SandboxExperimentRepository
  sandboxRunRepository: SandboxRunRepository
  sandboxGradeRepository: SandboxGradeRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
  /** App-owned agent-kind registry, for the live baseline system-prompt read. */
  agentKindRegistry: AgentKindRegistry
  /** The routing default model ref, used to default an experiment's judge model. */
  defaultModelRef?: ModelRef
}

/**
 * Management CRUD for the Sandbox (the parallel prompt/model testing surface): the
 * shipped baselines + stored candidate prompt versions, the fixture library (builtins
 * seeded lazily on first list, plus workspace-authored ones), and experiment definitions
 * + their result grids. Running an experiment lives in {@link SandboxRunService}; this
 * service is the persistence-facing half. Everything is workspace-scoped.
 */
export class SandboxService {
  constructor(private readonly deps: SandboxServiceDependencies) {}

  /** The full opt-in overview the UI loads when the Sandbox surface opens. */
  async overview(workspaceId: string): Promise<SandboxOverview> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const [prompts, fixtures, experiments] = await Promise.all([
      this.listPrompts(workspaceId),
      this.listFixtures(workspaceId),
      this.deps.sandboxExperimentRepository.list(workspaceId),
    ])
    return {
      agentKinds: SANDBOX_AGENT_KINDS,
      prompts,
      fixtures,
      experiments,
      maxCells: MAX_SANDBOX_CELLS,
    }
  }

  // ---- prompt versions ------------------------------------------------------

  /**
   * The shipped baselines (synthetic), the workspace's OWN prompts (also synthetic), then the
   * stored candidate versions.
   *
   * The workspace rows are what make an experiment mean something on a workspace that has edited a
   * prompt: without them the only control on offer is what the PRODUCT ships, so a candidate is
   * measured against text nobody there runs — silently, and while looking entirely correct. They
   * are projected per request from the revision log rather than synced, so a prompt saved in the
   * pipeline builder shows up on the next read with nothing to fall behind.
   */
  async listPrompts(workspaceId: string, agentKind?: string): Promise<SandboxPromptVersion[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const baselines = listBaselines(this.deps.clock.now(), this.deps.agentKindRegistry)
    const candidates = agentKind
      ? await this.deps.sandboxPromptVersionRepository.listByKind(workspaceId, agentKind)
      : await this.deps.sandboxPromptVersionRepository.list(workspaceId)
    const baseSlice = agentKind ? baselines.filter((b) => b.agentKind === agentKind) : baselines
    return [...baseSlice, ...(await this.workspacePrompts(workspaceId, agentKind)), ...candidates]
  }

  /**
   * The workspace's own agent prompts for the sandbox's catalog kinds, as synthetic versions.
   * ONE batched read for every kind (`listRevisionsByKinds`) — a point read per catalog kind would
   * be the banned N+1 on a surface the browser opens every time.
   */
  private async workspacePrompts(
    workspaceId: string,
    agentKind?: string,
  ): Promise<SandboxPromptVersion[]> {
    const repo = this.deps.agentPromptRepository
    if (!repo) return []
    const kinds = sandboxPromptKinds(agentKind)
    if (kinds.length === 0) return []
    return workspacePromptVersions(await repo.listRevisionsByKinds(workspaceId, kinds))
  }

  /**
   * Resolve a prompt version by id across all three origins, for a caller that holds only an id
   * (the promote path). Kept here rather than in the controller so the synthetic origins stay an
   * implementation detail of this service.
   */
  async getPrompt(workspaceId: string, id: string): Promise<SandboxPromptVersion | null> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const stored = await this.deps.sandboxPromptVersionRepository.get(workspaceId, id)
    if (stored) return stored
    return (await this.listPrompts(workspaceId)).find((version) => version.id === id) ?? null
  }

  /** Clone a shipped baseline into a fresh editable candidate lineage at version 1. */
  async clonePrompt(
    workspaceId: string,
    input: CloneSandboxPromptInput,
  ): Promise<SandboxPromptVersion> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const source = this.resolveBaseline(input.agentKind, input.basePromptId)
    const meta = sandboxKindMeta(input.agentKind)
    const name = input.name ?? meta?.label ?? input.agentKind
    const version = firstVersionFromBaseline(
      {
        agentKind: source.agentKind,
        systemText: source.systemText,
        basePromptId: source.basePromptId,
      },
      name,
      {
        id: this.deps.idGenerator.next('sbp'),
        createdAt: this.deps.clock.now(),
        createdBy: null,
        labels: input.labels ?? [],
      },
    )
    await this.deps.sandboxPromptVersionRepository.upsert(workspaceId, version)
    return version
  }

  /** Append a new candidate version. The parent may be a baseline (starts a lineage) or a candidate. */
  async saveVersion(
    workspaceId: string,
    input: SaveSandboxVersionInput,
  ): Promise<SandboxPromptVersion> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const fields = {
      id: this.deps.idGenerator.next('sbp'),
      createdAt: this.deps.clock.now(),
      createdBy: null,
      labels: input.labels ?? [],
    }
    if (input.parentId.startsWith('baseline:')) {
      const baseline = listBaselines(this.deps.clock.now(), this.deps.agentKindRegistry).find(
        (b) => b.id === input.parentId,
      )
      if (!baseline) throw new ValidationError(`Unknown baseline prompt "${input.parentId}"`)
      const meta = sandboxKindMeta(baseline.agentKind)
      const version = firstVersionFromBaseline(
        {
          agentKind: baseline.agentKind,
          systemText: input.systemText,
          basePromptId: baseline.basePromptId,
        },
        meta?.label ?? baseline.agentKind,
        fields,
      )
      await this.deps.sandboxPromptVersionRepository.upsert(workspaceId, version)
      return version
    }
    const parent = assertFound(
      await this.deps.sandboxPromptVersionRepository.get(workspaceId, input.parentId),
      'SandboxPromptVersion',
      input.parentId,
    )
    const version = nextVersion(parent, input.systemText, fields)
    await this.deps.sandboxPromptVersionRepository.upsert(workspaceId, version)
    return version
  }

  /** Replace a candidate version's labels. */
  async setLabels(
    workspaceId: string,
    id: string,
    input: SetSandboxLabelsInput,
  ): Promise<SandboxPromptVersion> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const existing = assertFound(
      await this.deps.sandboxPromptVersionRepository.get(workspaceId, id),
      'SandboxPromptVersion',
      id,
    )
    const updated = { ...existing, labels: input.labels }
    await this.deps.sandboxPromptVersionRepository.upsert(workspaceId, updated)
    return updated
  }

  /** Soft-archive a candidate version (hidden from the default listing). */
  async archivePrompt(workspaceId: string, id: string): Promise<void> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    await this.deps.sandboxPromptVersionRepository.archive(workspaceId, id, this.deps.clock.now())
  }

  // ---- fixtures -------------------------------------------------------------

  /** The fixture library, seeding the builtin fixtures on first use. */
  async listFixtures(workspaceId: string): Promise<SandboxFixture[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    await this.ensureBuiltinFixtures(workspaceId)
    return this.deps.sandboxFixtureRepository.list(workspaceId)
  }

  /** Create a workspace-authored fixture. */
  async createFixture(
    workspaceId: string,
    input: CreateSandboxFixtureInput,
  ): Promise<SandboxFixture> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const fixture: SandboxFixture = {
      id: this.deps.idGenerator.next('sbf'),
      kind: input.kind,
      name: input.name,
      payload: input.payload ?? null,
      repoRef: input.repoRef ?? null,
      objective: input.objective ?? null,
      origin: 'custom',
      createdAt: this.deps.clock.now(),
    }
    await this.deps.sandboxFixtureRepository.upsert(workspaceId, fixture)
    return fixture
  }

  /** Remove a workspace-authored fixture. Builtin fixtures cannot be removed. */
  async removeFixture(workspaceId: string, id: string): Promise<void> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const existing = await this.deps.sandboxFixtureRepository.get(workspaceId, id)
    if (existing?.origin === 'builtin') {
      throw new ConflictError('Builtin fixtures cannot be deleted.')
    }
    await this.deps.sandboxFixtureRepository.remove(workspaceId, id)
  }

  // ---- experiments ----------------------------------------------------------

  async listExperiments(workspaceId: string): Promise<SandboxExperiment[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    return this.deps.sandboxExperimentRepository.list(workspaceId)
  }

  /** An experiment with its result grid (cells + grades). */
  async getExperiment(workspaceId: string, id: string): Promise<SandboxExperimentDetail> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    return composeExperimentDetail(this.deps, workspaceId, id)
  }

  /** Create a draft experiment. Launching it (the run-driver) expands + grades the matrix. */
  async createExperiment(
    workspaceId: string,
    input: CreateSandboxExperimentInput,
  ): Promise<SandboxExperiment> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    // Refuse an un-runnable kind up front, through the same assertion the run-driver uses: the
    // driver only runs inline cells, so a draft naming a kind it cannot dispatch could be persisted
    // and never launched.
    assertSandboxRunnable(input.agentKind)
    if (!isRunnableMatrix(input.matrix)) {
      throw new ValidationError(
        'The experiment matrix needs at least one prompt, model and fixture',
      )
    }
    // ...and the same for the FIXTURES the matrix names, which only `launch` used to check. One
    // list read indexed into a Map rather than a point read per id (the banned N+1), and the
    // builtins fill in whatever a workspace has not had seeded yet.
    await this.assertRunnableFixtures(workspaceId, input.matrix.fixtureIds)
    const repeats = input.repeats ?? 1
    const total = cellCount(input.matrix, repeats)
    if (total > MAX_SANDBOX_CELLS) {
      throw new ValidationError(
        `This matrix expands to ${total} cells; the limit is ${MAX_SANDBOX_CELLS}. Narrow the selection.`,
      )
    }
    const experiment: SandboxExperiment = {
      id: this.deps.idGenerator.next('sbx'),
      name: input.name,
      agentKind: input.agentKind,
      judgeModel: input.judgeModel ?? this.defaultJudgeModel(),
      repeats,
      status: 'draft',
      matrix: input.matrix,
      budgetTokens: input.budgetTokens ?? null,
      createdAt: this.deps.clock.now(),
      createdBy: null,
    }
    await this.deps.sandboxExperimentRepository.upsert(workspaceId, experiment)
    return experiment
  }

  // ---- internals ------------------------------------------------------------

  /**
   * Refuse a matrix naming a fixture the run-driver cannot run (today: a repository seed).
   *
   * An unknown id is deliberately NOT refused here: the run-driver resolves fixtures against the
   * workspace store AND the builtins at launch, and a fixture can legitimately be authored between
   * create and launch. Refusing an absent id would only move that failure earlier while adding a way
   * for a valid draft to be rejected.
   */
  private async assertRunnableFixtures(workspaceId: string, fixtureIds: string[]): Promise<void> {
    const byId = new Map<string, SandboxFixture>()
    for (const fixture of listBuiltinFixtures(this.deps.clock.now())) byId.set(fixture.id, fixture)
    for (const fixture of await this.deps.sandboxFixtureRepository.list(workspaceId)) {
      byId.set(fixture.id, fixture)
    }
    for (const id of new Set(fixtureIds)) {
      const fixture = byId.get(id)
      if (fixture) assertSandboxRunnableFixture(fixture)
    }
  }

  /** Resolve the shipped baseline a clone derives from (by base-prompt id, else by kind). */
  private resolveBaseline(agentKind: string, basePromptId: string | null): SandboxPromptVersion {
    const baselines = listBaselines(this.deps.clock.now(), this.deps.agentKindRegistry)
    const wantedId = basePromptId ? `baseline:${basePromptId}` : baselineVersionId(agentKind)
    const source =
      baselines.find((b) => b.id === wantedId) ?? baselines.find((b) => b.agentKind === agentKind)
    if (!source) throw new ValidationError(`No baseline prompt for agent kind "${agentKind}"`)
    return source
  }

  /** Seed the builtin fixture library for a workspace that has none yet. Idempotent. */
  private async ensureBuiltinFixtures(workspaceId: string): Promise<void> {
    const current = await this.deps.sandboxFixtureRepository.list(workspaceId)
    if (current.length > 0) return
    for (const fixture of listBuiltinFixtures(this.deps.clock.now())) {
      await this.deps.sandboxFixtureRepository.upsert(workspaceId, fixture)
    }
  }

  /**
   * The judge model to use when the caller didn't pick one: the deployment's routing
   * default. We do NOT guess a provider — if no default is configured (e.g. a minimal
   * deployment), require an explicit `judgeModel` at create time rather than defaulting to
   * a vendor that may have no key, which would otherwise fail every cell's grade at launch.
   */
  private defaultJudgeModel(): string {
    const ref = this.deps.defaultModelRef
    if (!ref) {
      throw new ValidationError(
        'No default model is configured for the Sandbox judge; specify judgeModel explicitly.',
      )
    }
    return `${ref.provider}:${ref.model}`
  }
}
