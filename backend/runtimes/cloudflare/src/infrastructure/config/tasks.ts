import type { TasksConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { TasksConfig }

export function loadTasksConfig(env: Env): TasksConfig {
  // The task-source integration (Jira / GitHub Issues) is always on: tenants connect
  // their own trackers interactively through the UI, and which sources a workspace
  // OFFERS is a per-workspace toggle (task_source_settings) — there is no
  // deployment-level allow-list. Jira is always registered; GitHub Issues registers
  // whenever the GitHub integration is configured. It still requires a master key to
  // encrypt per-workspace credentials at rest, so we fail loudly at config load when
  // it is missing (mirrors the document-source integration).
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) {
    throw new Error(
      'ENCRYPTION_KEY is required: the task-source integration (Jira, …) encrypts ' +
        'per-workspace source credentials at rest. Set it to a base64-encoded key of at ' +
        'least 32 bytes.',
    )
  }
  return {
    enabled: true,
    encryptionKey,
  }
}
