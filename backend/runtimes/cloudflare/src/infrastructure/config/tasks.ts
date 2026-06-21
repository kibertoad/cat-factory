import type { TaskSourceKind } from '@cat-factory/kernel'
import type { TasksConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { TasksConfig }

const ALL_SOURCES: readonly TaskSourceKind[] = ['jira', 'github']

/** Parse the comma-separated `TASK_SOURCES` allow-list, defaulting to all. */
function parseSources(raw: string | undefined): TaskSourceKind[] {
  if (!raw?.trim()) return [...ALL_SOURCES]
  const requested = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const selected = ALL_SOURCES.filter((s) => requested.includes(s))
  return selected.length > 0 ? selected : [...ALL_SOURCES]
}

export function loadTasksConfig(env: Env): TasksConfig {
  // The task-source integration (Jira / GitHub issues) is always on: tenants connect
  // their own trackers interactively through the UI, so there is no service-level
  // enable flag. It still requires a master key to encrypt those per-workspace
  // credentials at rest, so we fail loudly at config load when it is missing rather
  // than silently disabling the feature (mirrors the document-source integration).
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
    sources: parseSources(env.TASK_SOURCES),
    encryptionKey,
  }
}
