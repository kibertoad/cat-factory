import type { GitLabConfig } from '@cat-factory/server'
import { GITLAB_PUBLIC_API_BASE } from '@cat-factory/gitlab'
import type { Env } from '../env'

export type { GitLabConfig }

/**
 * GitLab VCS provider config. Enabled (opt-in, default off) as soon as a `GITLAB_TOKEN` is
 * present — the single-token model (one connection per deployment) that mirrors local-mode's
 * PAT. The token itself is read straight from env at wiring time; this carries only the
 * non-secret address + the webhook secret the neutral ingest route verifies against.
 */
export function loadGitLabConfig(env: Env): GitLabConfig | undefined {
  const token = env.GITLAB_TOKEN?.trim()
  if (!token) return undefined
  return {
    enabled: true,
    apiBase: env.GITLAB_API_BASE?.trim() || GITLAB_PUBLIC_API_BASE,
    connectionId: env.GITLAB_CONNECTION_ID?.trim() || 'gitlab',
    webhookSecret: env.GITLAB_WEBHOOK_SECRET ?? '',
  }
}
