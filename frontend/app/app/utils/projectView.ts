import type { ProjectOutcomeStorage } from '@cat-factory/contracts'

/** A byte count in the unit a reader takes in at a glance. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Where an outcome's body lives, as one of three states a reader never renders alike. */
export function outcomeStorageState(
  storage: ProjectOutcomeStorage,
): 'inline' | 'offloaded' | 'unavailable' {
  if (!storage.readable) return 'unavailable'
  return storage.placement
}
