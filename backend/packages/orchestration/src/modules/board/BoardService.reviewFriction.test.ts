import { describe, expect, it } from 'vitest'
import type { Block, Notification, WorkspaceSettings } from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS, getErrorReason } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// The opt-in review-debt friction guard on addTask: a pass-through unless the seams are wired AND
// the workspace enabled friction, then a warn/hard-block 409 keyed off the shared verdict. These
// pin the wiring the pure-verdict unit tests can't: seam presence, the acknowledge flag semantics,
// and the createInternalTask exemption. Full design: backend/docs/review-debt-friction.md.
describe('BoardService review-debt friction on task creation', () => {
  const WS = 'ws_1'
  const NOW = 1_000_000
  const MINUTE = 60_000

  function frame(): Block {
    return {
      id: 'frame_svc',
      title: 'Service',
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'ready',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
    }
  }

  function openCard(blockId: string, createdAt: number): Notification {
    return {
      id: `n-${blockId}-${createdAt}`,
      type: 'merge_review',
      status: 'open',
      blockId,
      executionId: null,
      title: 'Merge review',
      body: '',
      createdAt,
      resolvedAt: null,
    }
  }

  function build(opts: {
    settings?: Partial<WorkspaceSettings>
    open?: Notification[]
    wireSeams?: boolean
  }) {
    const f = frame()
    const byId = new Map([[f.id, f]])
    const wireSeams = opts.wireSeams ?? true
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        get: async (ws: string, id: string) => (ws === WS ? (byId.get(id) ?? null) : null),
        listByWorkspace: async (ws: string) => (ws === WS ? [...byId.values()] : []),
        insert: async () => {},
      },
      serviceRepository: { getByFrameBlock: async () => null },
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => NOW },
      ...(wireSeams
        ? {
            reviewFrictionSettings: {
              get: async (): Promise<WorkspaceSettings> => ({
                ...DEFAULT_WORKSPACE_SETTINGS,
                ...opts.settings,
              }),
            },
            reviewFrictionNotifications: {
              listOpen: async (): Promise<Notification[]> => opts.open ?? [],
            },
          }
        : {}),
    } as unknown as BoardServiceDependencies
    return new BoardService(deps)
  }

  it('friction off ⇒ creates as normal even with a full review queue', async () => {
    const svc = build({
      settings: { reviewFrictionMode: 'off' },
      open: [openCard('a', NOW), openCard('b', NOW), openCard('c', NOW)],
    })
    const task = await svc.addTask(WS, 'frame_svc', { title: 'T' })
    expect(task.id).toBe('task_new')
  })

  it('seams unwired ⇒ pass-through (no friction, ever)', async () => {
    const svc = build({ wireSeams: false })
    const task = await svc.addTask(WS, 'frame_svc', { title: 'T' })
    expect(task.id).toBe('task_new')
  })

  it('warn tier ⇒ 409 review_debt_warn, tunnelled by acknowledgeReviewDebt', async () => {
    const cfg = {
      settings: { reviewFrictionMode: 'warn' as const, reviewFrictionWarnCount: 2 },
      open: [openCard('a', NOW), openCard('b', NOW)],
    }
    const err = await build(cfg)
      .addTask(WS, 'frame_svc', { title: 'T' })
      .catch((e: unknown) => e)
    expect(getErrorReason(err)).toBe('review_debt_warn')

    // Acknowledging lets the author proceed.
    const task = await build(cfg).addTask(WS, 'frame_svc', {
      title: 'T',
      acknowledgeReviewDebt: true,
    })
    expect(task.id).toBe('task_new')
  })

  it('enforce hard block ⇒ 409 review_debt_blocked that acknowledge can NOT tunnel', async () => {
    const cfg = {
      settings: {
        reviewFrictionMode: 'enforce' as const,
        reviewFrictionWarnCount: 1,
        reviewFrictionBlockStuckMinutes: 60,
      },
      open: [openCard('a', NOW - 120 * MINUTE)],
    }
    const err = await build(cfg)
      .addTask(WS, 'frame_svc', { title: 'T', acknowledgeReviewDebt: true })
      .catch((e: unknown) => e)
    expect(getErrorReason(err)).toBe('review_debt_blocked')
  })

  it('createInternalTask is exempt from friction', async () => {
    const svc = build({
      settings: {
        reviewFrictionMode: 'enforce',
        reviewFrictionWarnCount: 1,
        reviewFrictionBlockCount: 1,
      },
      open: [openCard('a', NOW), openCard('b', NOW)],
    })
    const task = await svc.createInternalTask(WS, { title: 'Loop anchor', description: '' })
    expect(task.internal).toBe(true)
  })
})
