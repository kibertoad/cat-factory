// A small board, shared by the inspector stories and the board stories.
//
// Two services. Auth Service holds a module with two tasks and one task of its own; API Gateway
// holds one task. All four tasks belong to one epic, so the epic spans both services. Statuses
// differ so the status dots and the dependency colours have something to show. `progress` is
// 0..1.
import type { Block } from '~/types/domain'
import { block } from './block.stories.mocks'

export const authService = block({
  id: 'svc_auth',
  title: 'Auth Service',
  level: 'frame',
  parentId: null,
})

export const gatewayService = block({
  id: 'svc_gateway',
  title: 'API Gateway',
  level: 'frame',
  parentId: null,
})

export const sessionsModule = block({
  id: 'mod_sessions',
  title: 'Sessions',
  level: 'module',
  parentId: 'svc_auth',
})

export const sessionEpic = block({
  id: 'epic_sessions',
  title: 'Session hardening',
  level: 'epic',
  parentId: null,
  status: 'planned',
  progress: 0,
})

export const loginTask = block({
  id: 'task_login',
  title: 'Login endpoint',
  parentId: 'mod_sessions',
  epicId: 'epic_sessions',
})

export const refreshTask = block({
  id: 'task_refresh',
  title: 'Token refresh',
  parentId: 'mod_sessions',
  status: 'done',
  progress: 1,
  epicId: 'epic_sessions',
})

/** Depends on both module tasks; one is merged, one is not, so it is blocked. */
export const logoutTask = block({
  id: 'task_logout',
  title: 'Log out everywhere',
  parentId: 'svc_auth',
  status: 'planned',
  progress: 0,
  dependsOn: ['task_login', 'task_refresh'],
  epicId: 'epic_sessions',
})

export const rateLimitTask = block({
  id: 'task_rate_limit',
  title: 'Rate-limit login attempts',
  parentId: 'svc_gateway',
  status: 'pr_ready',
  progress: 0.9,
  epicId: 'epic_sessions',
})

/** Every block above. A story that changes one block replaces it in a copy of this list. */
export const boardBlocks: Block[] = [
  authService,
  gatewayService,
  sessionsModule,
  sessionEpic,
  loginTask,
  refreshTask,
  logoutTask,
  rateLimitTask,
]

/** `boardBlocks` with one block replaced by id, or added when it is new. */
export function boardWith(changed: Block): Block[] {
  const rest = boardBlocks.filter((b) => b.id !== changed.id)
  return [...rest, changed]
}

/**
 * An initiative above the epic. It is not in `boardBlocks`, so the stories that use the board
 * are unchanged; a story with an initiative adds it and links the epic to it.
 */
export const authInitiative = block({
  id: 'init_identity',
  title: 'Identity platform',
  description: 'One sign-in, one session model and one audit trail across every Acme service.',
  level: 'initiative',
  parentId: null,
  status: 'planned',
  progress: 0,
})

/** `boardBlocks` plus the initiative, with the epic under it. */
export const boardWithInitiative: Block[] = [
  ...boardWith({ ...sessionEpic, initiativeId: authInitiative.id }),
  authInitiative,
]
