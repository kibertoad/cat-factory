import { describe, expect, it, vi } from 'vitest'
import type { ExecutionInstance, Notification } from '~/types/domain'
import {
  NOTIFICATION_ROUTES,
  OPEN_TASK_VERB_KEY,
  notificationTarget,
  notificationVerbKey,
  type NotificationRouteDeps,
} from '~/utils/notificationRoutes'
import { missingI18nKeys } from '../../test/i18nKeys'

// The card's verb and the place its click lands come from ONE resolution, so a button named for
// answering never just selects the task. These pin that, and that every verb names a real key.

function deps(instances: ExecutionInstance[] = []): NotificationRouteDeps {
  return {
    getInstance: (id) => instances.find((i) => i.id === id),
    select: vi.fn(),
    openStepDetail: vi.fn(),
    openDecision: vi.fn(),
    openFollowUps: vi.fn(),
    openForkDecision: vi.fn(),
    openPrReview: vi.fn(),
    openBugFishing: vi.fn(),
    openRequirementReview: vi.fn(),
    openClarityReview: vi.fn(),
    openInitiativeTracker: vi.fn(),
    openOperatorDashboard: vi.fn(),
  }
}

const card = (type: Notification['type'], over: Partial<Notification> = {}) =>
  ({ id: 'n1', type, blockId: 'blk', executionId: 'run', ...over }) as Notification

const run = (steps: unknown[]) => ({ id: 'run', blockId: 'blk', steps }) as ExecutionInstance

describe('notification routes', () => {
  it('names a real catalog key for every verb', () => {
    const keys = Object.values(NOTIFICATION_ROUTES)
      .map((r) => r.verbKey)
      .filter((k): k is string => k !== null)
    expect(missingI18nKeys([...keys, OPEN_TASK_VERB_KEY])).toEqual([])
  })

  it('answers a parked agent question in the decision window', () => {
    const d = deps([run([{ state: 'waiting_decision', decision: { id: 'dec', chosen: null } }])])
    const n = card('decision_required')
    expect(notificationVerbKey(n, d)).toBe('layout.notifications.goTo.answer')
    notificationTarget(n, d)!.open()
    expect(d.openDecision).toHaveBeenCalledWith('run', 'dec')
  })

  it('opens the step for any other park, such as an approval gate', () => {
    const d = deps([run([{ state: 'done' }, { state: 'waiting_decision' }])])
    notificationTarget(card('decision_required'), d)!.open()
    expect(d.openStepDetail).toHaveBeenCalledWith('run', 1)
  })

  it('says "Open" when only the task can be opened, and opens the task', () => {
    // The run is not loaded, or it is loaded and not parked (a Ralph loop that gave up).
    for (const d of [deps(), deps([run([{ state: 'failed' }])])]) {
      const n = card('decision_required')
      expect(notificationVerbKey(n, d)).toBe(OPEN_TASK_VERB_KEY)
      notificationTarget(n, d)!.open()
      expect(d.select).toHaveBeenCalledWith('blk')
    }
    expect(notificationVerbKey(card('fork_decision_pending'), deps())).toBe(OPEN_TASK_VERB_KEY)
  })

  it('gives no verb to a card whose act button is the action, or that has nowhere to go', () => {
    expect(notificationVerbKey(card('merge_review'), deps())).toBeNull()
    expect(notificationVerbKey(card('budget_paused', { blockId: null }), deps())).toBeNull()
    expect(notificationTarget(card('budget_paused', { blockId: null }), deps())).toBeNull()
  })

  it('sends a deployment-scoped health alert to the operator dashboard, with no block', () => {
    const d = deps()
    notificationTarget(card('platform_health', { blockId: null }), d)!.open()
    expect(d.openOperatorDashboard).toHaveBeenCalled()
  })
})
