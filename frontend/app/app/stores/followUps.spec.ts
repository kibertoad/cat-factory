import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ExecutionInstance } from '~/types/execution'
import { useExecutionStore } from '~/stores/execution'
import { useFollowUpsStore } from '~/stores/followUps'
import { useWorkspaceStore } from '~/stores/workspace'

// This store imports `useApi` by path rather than taking the Nuxt auto-import, so the setup file's
// inert `vi.stubGlobal('useApi', …)` does not reach it; the module is mocked instead.
const api = {
  answerFollowUp: vi.fn(),
  dismissFollowUp: vi.fn(),
  fileFollowUp: vi.fn(),
  queueFollowUp: vi.fn(),
}
vi.mock('~/composables/useApi', () => ({ useApi: () => api }))

// A pipeline may place MORE THAN ONE follow-up-enabled Coder, and the engine decides each item on
// the step that surfaced it (`FollowUpGateController.loadFollowUpItem` routes by item id, and says
// in as many words that it may not pick "the first enabled step"). The optimistic echo has to
// agree: the response is the OWNING step's state, so echoing it anywhere else paints one Coder's
// items, statuses and dropped-send-back stamps over another's until the stream repairs it.

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'question',
  title: `Question ${id}`,
  detail: '',
  status: 'pending',
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

/** Two Coder steps, each with its own surfaced item. */
const run = (rev: number): ExecutionInstance =>
  ({
    id: 'e1',
    blockId: 'b1',
    rev,
    currentStep: 1,
    steps: [
      {
        agentKind: 'coder',
        followUps: { enabled: true, loops: 0, maxLoops: 3, items: [item('fu_1')] },
      },
      {
        agentKind: 'coder',
        followUps: { enabled: true, loops: 0, maxLoops: 3, items: [item('fu_2')] },
      },
    ],
  }) as unknown as ExecutionInstance

const stepState = (index: number) => useExecutionStore().getInstance('e1')!.steps[index]!.followUps!

describe('followUps store: the optimistic echo lands on the item’s OWN step', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('echoes a second Coder’s answer onto that Coder, leaving the first untouched', async () => {
    // What the server returns for `fu_2`: the SECOND step's state, with the item now ruled on.
    const answered = {
      enabled: true,
      loops: 0,
      maxLoops: 3,
      items: [item('fu_2', { status: 'closed', answer: 'The brief stands.' })],
    }
    api.answerFollowUp.mockResolvedValue(answered)
    const execution = useExecutionStore()
    execution.hydrate([run(1)], 'ws1')

    await useFollowUpsStore().answerItem('e1', 'fu_2', 'The brief stands.', 'closed')

    expect(stepState(1).items[0]!.status).toBe('closed')
    // Routed by the FIRST enabled step this was `closed` too, and the first Coder's own card
    // reported a decision nobody made on it.
    expect(stepState(0).items.map((i) => i.id)).toEqual(['fu_1'])
    expect(stepState(0).items[0]!.status).toBe('pending')
  })

  it('leaves both steps alone when the response names no step it can find', async () => {
    // A run whose cached copy predates the item (the stream has not delivered it yet) must not
    // fall back to painting the response somewhere: doing nothing is what the stream repairs.
    api.dismissFollowUp.mockResolvedValue({ enabled: true, loops: 0, maxLoops: 3, items: [] })
    const execution = useExecutionStore()
    execution.hydrate([run(1)], 'ws1')

    await useFollowUpsStore().dismissItem('e1', 'fu_unknown')

    expect(stepState(0).items[0]!.status).toBe('pending')
    expect(stepState(1).items[0]!.status).toBe('pending')
  })
})
