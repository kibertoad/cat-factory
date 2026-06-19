import type { AgentRunRepository } from '@cat-factory/kernel'
import type { Core } from '@cat-factory/orchestration'
import type { SessionPayload } from '../auth/signing'
import type { AppConfig } from '../config/types'

// The runtime-neutral request context shared by every controller. A facade builds a
// `ServerContainer` per request (the domain `Core` plus the resolved config and the
// kind-spanning agent-run repository) and stashes it on the Hono context; controllers
// resolve their services from `c.get('container')`. The facade's own Hono app may add
// runtime `Bindings` (e.g. the Worker's `Env`) on top of these Variables.

export interface ServerContainer extends Core {
  config: AppConfig
  /** Kind-spanning view over agent_runs (retry dispatch + the cron sweeper). */
  agentRunRepository: AgentRunRepository
}

/** Hono generics shared by the cross-runtime controllers (Variables only — no Bindings). */
export type AppEnv = {
  Variables: {
    container: ServerContainer
    /** The authenticated user, set by `requireAuth` when auth is enabled. */
    user?: SessionPayload
  }
}
