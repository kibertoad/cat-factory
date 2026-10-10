import type { GitLabConfig } from '@cat-factory/server'
import { GITLAB_PUBLIC_API_BASE } from '@cat-factory/gitlab'
import type { Env } from '../env'

export type { GitLabConfig }

/**
 * GitLab VCS provider config. `enabled` is the opt-in (default off) for the single-token model
 * (one connection per deployment) that mirrors local-mode's PAT, and flips as soon as a
 * `GITLAB_TOKEN` is present. The token itself is read straight from env at wiring time; this
 * carries only the non-secret address + the webhook secret the neutral ingest route verifies
 * against.
 *
 * The config itself is always returned: `apiBase` is the address of the instance a deployment
 * talks to, which is a fact independent of that opt-in (see {@link GitLabConfig}). Mirrors the
 * Node facade's `loadGitLabConfig` (per "keep the runtimes symmetric").
 */
export function loadGitLabConfig(env: Env): GitLabConfig {
  const token = env.GITLAB_TOKEN?.trim()
  return {
    enabled: !!token,
    apiBase: env.GITLAB_API_BASE?.trim() || GITLAB_PUBLIC_API_BASE,
    connectionId: env.GITLAB_CONNECTION_ID?.trim() || 'gitlab',
    webhookSecret: env.GITLAB_WEBHOOK_SECRET ?? '',
    // The shared ENCRYPTION_KEY seals per-workspace GitLab PATs for the connect flow;
    // domain-separated under `cat-factory:vcs-token`. Absent ⇒ the connect surface stays off.
    encryptionKey: env.ENCRYPTION_KEY?.trim() || undefined,
  }
}
