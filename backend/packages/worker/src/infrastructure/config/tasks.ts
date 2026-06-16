import type { TaskSourceKind } from '@cat-factory/core'
import type { Env } from '../env'

const ALL_SOURCES: readonly TaskSourceKind[] = ['jira']

export interface TasksConfig {
  /**
   * Opt-in flag. Requires `TASKS_ENCRYPTION_KEY`: per-workspace source
   * credentials are always stored encrypted at rest, so the feature refuses to
   * assemble without a master key (never a silent plaintext fallback).
   */
  enabled: boolean
  /** Which source providers to register (default: all). */
  sources: TaskSourceKind[]
  /** Service-level master key (base64) backing source-credential encryption at rest. */
  encryptionKey?: string
}

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
