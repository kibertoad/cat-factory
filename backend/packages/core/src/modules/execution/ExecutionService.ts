import type { Block, ExecutionInstance, PipelineStep } from '../../domain/types'
import { assertFound, ConflictError, NotFoundError } from '../../domain/errors'
import { DEFAULT_CONFIDENCE_THRESHOLD } from '../../domain/catalog'
import type {
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  WorkspaceRepository,
} from '../../ports/repositories'
import type { IdGenerator } from '../../ports/runtime'
import type { AgentExecutor, AgentRunContext } from '../../ports/agent-executor'
import type { WorkRunner } from '../../ports/work-runner'
import { serviceOf } from '../board/board.logic'
import type { BoardService } from '../board/BoardService'
import { requireWorkspace } from '../workspaces/WorkspaceService'
import type { AdvanceOptions, AdvanceResult } from './advance'

export interface ExecutionServiceDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  idGenerator: IdGenerator
  agentExecutor: AgentExecutor
  workRunner: WorkRunner
  boardService: BoardService
}

/**
 * The execution engine. It orchestrates a pipeline of agent-performed steps and
 * is fully deterministic: a `tick` advances every running pipeline by exactly
 * one step, delegating the actual work — and the choice of whether to pause for
 * a human decision — to the injected {@link AgentExecutor}. All randomness and
 * LLM behaviour live behind that port, so the engine here can be tested with a
 * deterministic fake and no timing/delays.
 */
export class ExecutionService {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly blockRepository: BlockRepository
  private readonly pipelineRepository: PipelineRepository
  private readonly executionRepository: ExecutionRepository
  private readonly idGenerator: IdGenerator
  private readonly agentExecutor: AgentExecutor
  private readonly workRunner: WorkRunner
  private readonly board: BoardService

  constructor({
    workspaceRepository,
    blockRepository,
    pipelineRepository,
    executionRepository,
    idGenerator,
    agentExecutor,
    workRunner,
    boardService,
  }: ExecutionServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.blockRepository = blockRepository
    this.pipelineRepository = pipelineRepository
    this.executionRepository = executionRepository
    this.idGenerator = idGenerator
    this.agentExecutor = agentExecutor
    this.workRunner = workRunner
    this.board = boardService
  }

  private requireWorkspace(workspaceId: string) {
    return requireWorkspace(this.workspaceRepository, workspaceId)
  }

  private async requireBlock(workspaceId: string, id: string): Promise<Block> {
    return assertFound(await this.blockRepository.get(workspaceId, id), 'Block', id)
  }

  /** Start a pipeline against a block, replacing any prior run on it. */
  async start(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    await this.requireBlock(workspaceId, blockId)
    const pipeline = assertFound(
      await this.pipelineRepository.get(workspaceId, pipelineId),
      'Pipeline',
      pipelineId,
    )

    await this.executionRepository.deleteByBlock(workspaceId, blockId)

    const steps: PipelineStep[] = pipeline.agentKinds.map((kind, i) => ({
      agentKind: kind,
      state: i === 0 ? 'working' : 'pending',
      progress: 0,
      decision: null,
    }))
    const instance: ExecutionInstance = {
      id: this.idGenerator.next('exec'),
      blockId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      steps,
      currentStep: 0,
      status: 'running',
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.blockRepository.update(workspaceId, blockId, {
      status: 'in_progress',
      progress: 0,
      executionId: instance.id,
    })
    // Hand the run off to the durable runner so it progresses without a browser
    // driving `tick`. With the no-op runner (tick/simulator mode) this does
    // nothing and progress is driven by `tick` as before.
    await this.workRunner.startRun(workspaceId, instance.id)
    return instance
  }

  /**
   * Advance a single run by exactly one step and report what happened. This is
   * the durable driver's entry point: it reloads the run from storage (so it is
   * safe under replay/retry), no-ops unless the run is actively running, and
   * otherwise performs one agent step via the shared {@link stepInstance} logic.
   */
  async advanceInstance(
    workspaceId: string,
    executionId: string,
    options: AdvanceOptions = {},
  ): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || instance.status !== 'running') return { kind: 'noop' }
    return this.stepInstance(workspaceId, instance, options)
  }

  /**
   * Advance the workspace by up to `ticks` steps. Each tick advances every
   * running instance by one agent-performed step; it stops early once nothing is
   * running (everything is done or blocked on a decision).
   */
  async tick(workspaceId: string, ticks = 1): Promise<ExecutionInstance[]> {
    await this.requireWorkspace(workspaceId)
    for (let i = 0; i < ticks; i++) {
      const instances = await this.executionRepository.listByWorkspace(workspaceId)
      const running = instances.filter((e) => e.status === 'running')
      if (running.length === 0) break
      for (const instance of running) await this.stepInstance(workspaceId, instance)
    }
    return this.executionRepository.listByWorkspace(workspaceId)
  }

  /** Advance a single running instance by one step, persisting the result. */
  private async stepInstance(
    workspaceId: string,
    instance: ExecutionInstance,
    options: AdvanceOptions = {},
  ): Promise<AdvanceResult> {
    const step = instance.steps[instance.currentStep]
    if (!step) return { kind: 'noop' }
    if (step.state === 'waiting_decision') {
      instance.status = 'blocked'
      await this.executionRepository.upsert(workspaceId, instance)
      return { kind: 'awaiting_decision', decisionId: step.decision!.id }
    }
    step.state = 'working'

    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    const result = await this.runAgent(instance, step, isFinalStep, block, options)

    // The agent asked for a human decision and this step hasn't resolved one yet.
    if (result.decision && !step.decision?.chosen) {
      step.decision = {
        id: this.idGenerator.next('dec'),
        question: result.decision.question,
        options: [...result.decision.options],
        chosen: null,
      }
      step.state = 'waiting_decision'
      instance.status = 'blocked'
      await this.updateBlockProgress(workspaceId, instance, 'blocked')
      await this.executionRepository.upsert(workspaceId, instance)
      return { kind: 'awaiting_decision', decisionId: step.decision.id }
    }

    // The step completed.
    step.output = result.output ?? ''
    if (result.model) step.model = result.model
    step.progress = 1
    step.state = 'done'

    if (isFinalStep) {
      instance.status = 'done'
      await this.finalizeBlock(workspaceId, instance, result.confidence)
      await this.executionRepository.upsert(workspaceId, instance)
      return { kind: 'done' }
    }
    instance.currentStep += 1
    const next = instance.steps[instance.currentStep]
    if (next) next.state = 'working'
    await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.executionRepository.upsert(workspaceId, instance)
    return { kind: 'continue' }
  }

  /**
   * Build the agent context and invoke the agent. Failures are swallowed into
   * the step output so the simulation never wedges — unless `rethrowAgentErrors`
   * is set (the durable path), in which case the error propagates so the
   * driver's per-step retry can take over.
   */
  private async runAgent(
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    block: Block,
    options: AdvanceOptions = {},
  ) {
    const context: AgentRunContext = {
      agentKind: step.agentKind,
      pipelineName: instance.pipelineName,
      stepIndex: instance.currentStep,
      isFinalStep,
      block: {
        title: block.title,
        type: block.type,
        description: block.description,
        features: block.features,
      },
      priorOutputs: instance.steps
        .slice(0, instance.currentStep)
        .filter((s) => s.output)
        .map((s) => ({ agentKind: s.agentKind, output: s.output! })),
      decisions: instance.steps
        .filter((s, i) => i < instance.currentStep && s.decision?.chosen)
        .map((s) => ({ question: s.decision!.question, chosen: s.decision!.chosen! })),
      resolvedDecision: step.decision?.chosen
        ? { question: step.decision.question, chosen: step.decision.chosen }
        : null,
    }

    try {
      return await this.agentExecutor.run(context)
    } catch (error) {
      // The durable driver wants real failures to surface so its per-step retry
      // can kick in (and the error gets persisted after retries are exhausted).
      if (options.rethrowAgentErrors) throw error
      // Otherwise a failed agent must not wedge the simulation; record and complete.
      return {
        output: `Agent error: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /** Set the block's in-progress/blocked status and step-completion progress. */
  private async updateBlockProgress(
    workspaceId: string,
    instance: ExecutionInstance,
    status: 'in_progress' | 'blocked',
  ): Promise<void> {
    const total = instance.steps.length || 1
    const done = instance.steps.filter((s) => s.state === 'done').length
    await this.blockRepository.update(workspaceId, instance.blockId, {
      status,
      progress: Math.min(1, done / total),
    })
  }

  /** A pipeline finished: a task auto-merges or opens a PR; a frame is done. */
  private async finalizeBlock(
    workspaceId: string,
    instance: ExecutionInstance,
    confidence: number | undefined,
  ): Promise<void> {
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block || block.status === 'done') return

    if ((block.level ?? 'frame') !== 'task') {
      await this.blockRepository.update(workspaceId, block.id, {
        status: 'done',
        progress: 1,
      })
      return
    }

    // No confidence reported (e.g. a real LLM agent) means confident → merge.
    const score = confidence ?? 1
    const threshold = block.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD
    await this.blockRepository.update(workspaceId, block.id, { confidence: score })
    if (score >= threshold) {
      await this.finalizeMerge(workspaceId, block.id)
    } else {
      await this.blockRepository.update(workspaceId, block.id, {
        status: 'pr_ready',
        progress: 1,
      })
    }
  }

  /** Mark a block implemented; for a task, materialise its assigned module. */
  private async finalizeMerge(workspaceId: string, blockId: string): Promise<void> {
    const block = await this.blockRepository.get(workspaceId, blockId)
    if (!block) return
    await this.blockRepository.update(workspaceId, blockId, { status: 'done', progress: 1 })
    if ((block.level ?? 'frame') === 'task') {
      await this.applyModuleAssignment(workspaceId, blockId)
    }
  }

  /**
   * Implementing a task assigned to a module materialises that module: create it
   * in the service if missing, then move the task inside it.
   */
  private async applyModuleAssignment(workspaceId: string, taskId: string): Promise<void> {
    const task = await this.blockRepository.get(workspaceId, taskId)
    if (!task || !task.moduleName) return
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const service = serviceOf(blocks, task)
    if (!service) return

    let module = blocks.find(
      (b) => b.parentId === service.id && b.level === 'module' && b.title === task.moduleName,
    )
    if (!module) {
      module = await this.board.addModule(workspaceId, service.id, {
        name: task.moduleName,
      })
    }
    if (module.id !== task.parentId) {
      const n = blocks.filter((b) => b.parentId === module!.id && b.level === 'task').length
      await this.board.reparent(workspaceId, taskId, {
        parentId: module.id,
        position: { x: 16 + (n % 2) * 190, y: 40 + Math.floor(n / 2) * 130 },
      })
    }
  }

  /** Resolve a pending decision; the next tick lets the agent finish the step. */
  async resolveDecision(
    workspaceId: string,
    executionId: string,
    decisionId: string,
    choice: string,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const step = instance.steps.find((s) => s.decision?.id === decisionId)
    if (!step || !step.decision) throw new NotFoundError('Decision', decisionId)

    step.decision.chosen = choice
    step.state = 'working'
    if (instance.status === 'blocked') instance.status = 'running'
    await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.executionRepository.upsert(workspaceId, instance)
    // Wake the parked durable run, if any. The DB write above remains the source
    // of truth (so tick mode and the sweeper still work); the signal is an
    // optimisation that lets a workflow continue immediately.
    await this.workRunner.signalDecision(workspaceId, instance.id, decisionId, choice)
    return instance
  }

  /** Merge an open PR: a block moves from `pr_ready` to `done`. */
  async mergePr(workspaceId: string, blockId: string): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const block = await this.requireBlock(workspaceId, blockId)
    if (block.status !== 'pr_ready') {
      throw new ConflictError(`Block '${blockId}' has no PR awaiting merge`)
    }
    await this.finalizeMerge(workspaceId, blockId)
    return this.requireBlock(workspaceId, blockId)
  }

  /**
   * Record a terminal agent failure: persist the error, stop the run, and open
   * the block for human review (`pr_ready`). Called by the durable driver once a
   * step has exhausted its retries.
   */
  async failRun(workspaceId: string, executionId: string, message: string): Promise<void> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance) return
    await this.executionRepository.markError(workspaceId, executionId, message)
    await this.blockRepository.update(workspaceId, instance.blockId, {
      status: 'pr_ready',
      progress: 1,
    })
  }

  /** Cancel the run on a block, returning it to `planned`. */
  async cancel(workspaceId: string, blockId: string): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    await this.requireBlock(workspaceId, blockId)
    // Tear down the durable run (if any) before removing its record.
    const existing = await this.executionRepository.getByBlock(workspaceId, blockId)
    if (existing) await this.workRunner.cancelRun(workspaceId, existing.id)
    await this.executionRepository.deleteByBlock(workspaceId, blockId)
    await this.blockRepository.update(workspaceId, blockId, {
      status: 'planned',
      progress: 0,
      executionId: null,
    })
    return this.requireBlock(workspaceId, blockId)
  }
}
