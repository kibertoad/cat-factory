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
  // Opt-in, matching the document-source integration's default-off convention.
  // Requires the encryption key so source credentials are never stored in
  // plaintext (mirrors the documents/environments fail-closed gate).
  return {
    enabled: env.TASKS_ENABLED === 'true' && !!env.TASKS_ENCRYPTION_KEY,
    sources: parseSources(env.TASK_SOURCES),
    encryptionKey: env.TASKS_ENCRYPTION_KEY,
  }
}
