import type { ExecutionInstance, Notification, PipelineStep } from '~/types/domain'

/**
 * Where each notification takes a person, and the verb that names it (issue #2258, finding F4).
 *
 * ONE row per type holds both, so the button's word and the place it opens cannot drift apart:
 * the inbox's title link and its primary button both dispatch through {@link notificationTarget},
 * and the verb is decided from the SAME resolution. A route that can only fall back to selecting
 * the task (its run is not loaded, or not parked) is named "Open", because that is what happens.
 *
 * Exhaustive over the notification types, so a new type has to decide. A `null` verb means the
 * card's own act button already IS the action (Merge, Retry run, Acknowledge), or there is nowhere
 * to go beyond the card itself.
 */

/** The store reads and window openers a route needs, injected so this stays testable. */
export interface NotificationRouteDeps {
  getInstance: (id: string) => ExecutionInstance | undefined
  select: (blockId: string) => void
  openStepDetail: (instanceId: string, stepIndex: number) => void
  openDecision: (instanceId: string, decisionId: string) => void
  openFollowUps: (instanceId: string) => void
  openForkDecision: (instanceId: string) => void
  openPrReview: (instanceId: string) => void
  openBugFishing: (instanceId: string) => void
  openRequirementReview: (blockId: string) => void
  openClarityReview: (blockId: string) => void
  openInitiativeTracker: (blockId: string) => void
  openOperatorDashboard: () => void
}

/**
 * Where a click lands. `surface` opens the window that answers the card; `task` only selects the
 * task on the board, which is the fallback when that window cannot open.
 */
export interface NotificationTarget {
  readonly kind: 'surface' | 'task'
  readonly open: () => void
}

interface NotificationRoute {
  /** The verb for a `surface` target, or null when the card's act button is already the verb. */
  readonly verbKey: string | null
  readonly resolve: (n: Notification, deps: NotificationRouteDeps) => NotificationTarget | null
}

/** The verb for a route that can only select the task. */
export const OPEN_TASK_VERB_KEY = 'layout.notifications.goTo.open'

const surface = (open: () => void): NotificationTarget => ({ kind: 'surface', open })

/** Select the card's task: the fallback every block-bound route shares. */
function selectTask(n: Notification, deps: NotificationRouteDeps): NotificationTarget | null {
  const blockId = n.blockId
  return blockId ? { kind: 'task', open: () => deps.select(blockId) } : null
}

/** A window keyed by the card's run, when that run is loaded; else the task. */
function byRun(open: (deps: NotificationRouteDeps, instanceId: string) => void) {
  return (n: Notification, deps: NotificationRouteDeps): NotificationTarget | null => {
    const id = n.executionId
    if (id && deps.getInstance(id)) return surface(() => open(deps, id))
    return selectTask(n, deps)
  }
}

/** The run's step matching `find`, opened through the universal step dispatch; else the task. */
function byStep(find: (step: PipelineStep) => boolean) {
  return (n: Notification, deps: NotificationRouteDeps): NotificationTarget | null => {
    const instance = n.executionId ? deps.getInstance(n.executionId) : undefined
    const index = instance?.steps.findIndex(find) ?? -1
    if (instance && index >= 0) return surface(() => deps.openStepDetail(instance.id, index))
    return selectTask(n, deps)
  }
}

/** A window keyed by the card's block. */
function byBlock(open: (deps: NotificationRouteDeps, blockId: string) => void) {
  return (n: Notification, deps: NotificationRouteDeps): NotificationTarget | null => {
    const blockId = n.blockId
    return blockId ? surface(() => open(deps, blockId)) : null
  }
}

/**
 * A parked step: an agent's question opens the decision window, where it is answered (as from the
 * task card and the toolbar); any other park (an approval gate, an iteration cap) opens the step.
 * A card whose run is not parked, which a Ralph loop or an exhausted gate also raises, opens the
 * task.
 */
function parkedStep(n: Notification, deps: NotificationRouteDeps): NotificationTarget | null {
  const instance = n.executionId ? deps.getInstance(n.executionId) : undefined
  const index = instance?.steps.findIndex((s) => s.state === 'waiting_decision') ?? -1
  const step = instance?.steps[index]
  if (!instance || !step) return selectTask(n, deps)
  const decision = step.decision
  if (decision && !decision.chosen) {
    return surface(() => deps.openDecision(instance.id, decision.id))
  }
  return surface(() => deps.openStepDetail(instance.id, index))
}

const verb = (leaf: string) => `layout.notifications.goTo.${leaf}`

export const NOTIFICATION_ROUTES: Record<Notification['type'], NotificationRoute> = {
  merge_review: { verbKey: null, resolve: selectTask },
  pipeline_complete: { verbKey: null, resolve: selectTask },
  merge_tag_request: { verbKey: null, resolve: selectTask },
  ci_failed: { verbKey: null, resolve: selectTask },
  test_failed: { verbKey: null, resolve: selectTask },
  deploy_blocked: { verbKey: null, resolve: selectTask },
  release_regression: { verbKey: null, resolve: selectTask },
  infra_unreachable: { verbKey: null, resolve: selectTask },
  key_drift: { verbKey: null, resolve: selectTask },
  // Raised with no block, so neither has anywhere to go beyond the card.
  budget_threshold: { verbKey: null, resolve: selectTask },
  budget_paused: { verbKey: null, resolve: selectTask },
  // Deployment-scoped: the dashboard holds the live numbers behind the alert.
  platform_health: { verbKey: null, resolve: (_n, deps) => surface(deps.openOperatorDashboard) },
  requirement_review: {
    verbKey: verb('review'),
    resolve: byBlock((deps, id) => deps.openRequirementReview(id)),
  },
  clarity_review: {
    verbKey: verb('review'),
    resolve: byBlock((deps, id) => deps.openClarityReview(id)),
  },
  decision_required: { verbKey: verb('answer'), resolve: parkedStep },
  human_test_ready: {
    verbKey: verb('test'),
    resolve: byStep((s) => s.agentKind === 'human-test' && s.state === 'waiting_decision'),
  },
  visual_confirmation_ready: {
    verbKey: verb('confirm'),
    resolve: byStep((s) => s.agentKind === 'visual-confirmation' && s.state === 'waiting_decision'),
  },
  human_review: { verbKey: verb('review'), resolve: byStep((s) => s.agentKind === 'human-review') },
  judge_review: {
    verbKey: verb('review'),
    resolve: byStep((s) => s.judge?.status === 'awaiting_decision'),
  },
  followup_pending: {
    verbKey: verb('triage'),
    resolve: byRun((deps, id) => deps.openFollowUps(id)),
  },
  fork_decision_pending: {
    verbKey: verb('choose'),
    resolve: byRun((deps, id) => deps.openForkDecision(id)),
  },
  pr_review_ready: { verbKey: verb('review'), resolve: byRun((deps, id) => deps.openPrReview(id)) },
  bug_fishing_triage: {
    verbKey: verb('triage'),
    resolve: byRun((deps, id) => deps.openBugFishing(id)),
  },
  initiative: {
    verbKey: verb('open'),
    resolve: byBlock((deps, id) => deps.openInitiativeTracker(id)),
  },
}

/** Where a click on this card lands, or null when it has nowhere to go. */
export function notificationTarget(
  n: Notification,
  deps: NotificationRouteDeps,
): NotificationTarget | null {
  return NOTIFICATION_ROUTES[n.type].resolve(n, deps)
}

/**
 * The primary button's verb, from the same resolution the click takes: the route's verb when its
 * window can open, "Open" when only the task can, null when the card has no verb or nowhere to go.
 */
export function notificationVerbKey(n: Notification, deps: NotificationRouteDeps): string | null {
  const route = NOTIFICATION_ROUTES[n.type]
  if (!route.verbKey) return null
  const target = route.resolve(n, deps)
  if (!target) return null
  return target.kind === 'surface' ? route.verbKey : OPEN_TASK_VERB_KEY
}
