import { describe, expect, it, vi } from 'vitest'
import {
  createRecordingLogger,
  noopOperationalMetrics,
  PipelineRegistry,
  REVIEW_PIPELINE_ID,
} from '@cat-factory/kernel'
import type { Block, Pipeline, PipelineRepository } from '@cat-factory/kernel'
import { createPipelineAdoption } from '../pipelines/pipelineAdoption.js'
import {
  PostMergeBoardController,
  type PostMergeBoardControllerDeps,
  type PostMergeBoardHost,
} from './PostMergeBoardController.js'

const WS = 'ws_1'

function task(over: Partial<Block> = {}): Block {
  return {
    id: 'blk_dependent',
    title: 'Expose orders over HTTP',
    level: 'task',
    status: 'ready',
    dependsOn: ['blk_merged'],
    ...over,
  } as unknown as Block
}

/**
 * The controller over fake collaborators, with the REAL adoption collaborator (over a fake store) so
 * the assertion covers what the board can resolve rather than a stubbed answer.
 */
function subject(options: { blocks: Block[]; stored?: Pipeline[]; registry?: PipelineRegistry }) {
  const rows = new Map((options.stored ?? []).map((p) => [p.id, p]))
  const pipelineRepository = {
    listByWorkspace: async () => [...rows.values()],
    get: async (_ws: string, id: string) => rows.get(id) ?? null,
    insertIfAbsent: async (_ws: string, p: Pipeline) => void (rows.has(p.id) || rows.set(p.id, p)),
  } as unknown as PipelineRepository
  const logger = createRecordingLogger()
  const host: PostMergeBoardHost = {
    blockRepository: { listByWorkspace: async () => options.blocks },
    pipelineRepository,
    pipelineAdoption: createPipelineAdoption({
      pipelineRepository,
      pipelineRegistry: options.registry,
      operationalMetrics: noopOperationalMetrics,
    }),
    admission: { augmentWithCrossWorkspaceDeps: async (blocks: Block[]) => blocks },
    board: {},
    events: {},
    logger,
  } as unknown as PostMergeBoardHost
  const start = vi.fn(async () => {})
  const deps = {
    resolveIndividualVendors: async () => [],
    start,
  } as unknown as PostMergeBoardControllerDeps
  const warnings = () => logger.lines.filter((line) => line.level === 'warn')
  return { controller: new PostMergeBoardController(host, deps), start, warnings }
}

describe('PostMergeBoardController.autoStartDependents', () => {
  it('starts a dependent pinned to a catalog pipeline the board never adopted', async () => {
    // The half of adoption the manual start path fixed and this one did not: a dependent PINS the
    // operation's pipeline, the board holds no row for it, and the old resolve dropped the dependent
    // silently — so a merge propagated into a task that simply never began. `start` itself performs
    // the adopting write; resolving here only has to agree with it about what is launchable.
    const registry = new PipelineRegistry()
    registry.register({
      id: 'pl_org_op',
      name: 'Introduce API',
      purpose: 'build',
      builtin: true,
      version: 1,
      agentKinds: ['coder'],
    })
    const { controller, start, warnings } = subject({
      blocks: [
        task({ pipelineId: 'pl_org_op' }),
        { id: 'blk_merged', level: 'task', status: 'done', dependsOn: [] } as unknown as Block,
      ],
      registry,
    })
    await controller.autoStartDependents(WS, 'blk_merged')
    expect(start).toHaveBeenCalledWith(WS, 'blk_dependent', 'pl_org_op', { initiatedBy: null })
    expect(warnings()).toEqual([])
  })

  it('prefers the board’s own stored row over the catalog definition', async () => {
    // Precedence, same as `adoptForRun`: a workspace that holds a copy runs its copy. Asserted on
    // the auto-start path too, because this one resolves from a LIST rather than a point read and so
    // could plausibly have consulted the catalog first.
    const { controller, start } = subject({
      blocks: [
        task({ pipelineId: REVIEW_PIPELINE_ID }),
        { id: 'blk_merged', level: 'task', status: 'done', dependsOn: [] } as unknown as Block,
      ],
      stored: [
        {
          id: REVIEW_PIPELINE_ID,
          name: 'Mine',
          purpose: 'build',
          agentKinds: ['coder'],
          builtin: true,
          version: 1,
        },
      ],
    })
    await controller.autoStartDependents(WS, 'blk_merged')
    expect(start).toHaveBeenCalledWith(WS, 'blk_dependent', REVIEW_PIPELINE_ID, {
      initiatedBy: null,
    })
  })

  it('reports the dependent it cannot resolve a pipeline for instead of dropping it', async () => {
    // Neither stored nor adoptable (a deleted custom pipeline, a retired built-in): the dependent
    // can never auto-start, and the only other symptom is work that never begins. The pin has to be
    // NAMED, because it is what tells an operator this is a stale reference rather than an empty
    // board.
    const { controller, start, warnings } = subject({
      blocks: [
        task({ pipelineId: 'pl_deleted' }),
        { id: 'blk_merged', level: 'task', status: 'done', dependsOn: [] } as unknown as Block,
      ],
    })
    await controller.autoStartDependents(WS, 'blk_merged')
    expect(start).not.toHaveBeenCalled()
    const [warning] = warnings()
    expect(warning?.msg).toContain('no pipeline resolved')
    expect(warning?.fields).toMatchObject({ blockId: 'blk_dependent', pipelineId: 'pl_deleted' })
  })
})
