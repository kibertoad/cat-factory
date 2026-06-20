import type { DocumentSourceKind, TaskSourceKind } from '~/types/domain'

// Shared model + orchestration for attaching external context (imported docs and
// tracker issues) to a board block. A "pending" item is something the user has
// chosen to attach but which is only linked once the block exists — so the task
// creation popup can collect selections up front and commit them after the task
// is created. Search hits and pasted URLs carry `needsImport: true`: they are not
// yet projected locally, so they are imported (fetched + persisted) before being
// linked; already-imported items are linked directly. Reused wherever context is
// attached (the add-task popup today; the inspector can adopt it later).

export interface PendingContext {
  kind: 'document' | 'task'
  source: DocumentSourceKind | TaskSourceKind
  /** A canonical external id (already-imported / search hit) or a pasted URL/ref. */
  externalId: string
  title: string
  /** Secondary line: an issue status, a source label, the raw URL, … */
  subtitle?: string
  /** Lucide icon for the row. */
  icon?: string
  /** True when the item must be imported before it can be linked. */
  needsImport: boolean
}

/** Stable key for a pending item, used for dedupe + selection toggles. */
export function contextKey(c: Pick<PendingContext, 'kind' | 'source' | 'externalId'>): string {
  return `${c.kind}:${c.source}:${c.externalId}`
}

export function useContextLinking() {
  const documents = useDocumentsStore()
  const tasks = useTasksStore()

  /**
   * Import (when needed) then link every pending item to `blockId`. Each failure
   * is counted rather than aborting the batch, so one bad attachment doesn't sink
   * the rest; returns how many failed.
   */
  async function linkPending(blockId: string, items: PendingContext[]): Promise<number> {
    let failed = 0
    for (const item of items) {
      try {
        if (item.kind === 'document') {
          const source = item.source as DocumentSourceKind
          const externalId = item.needsImport
            ? (await documents.importDocument(source, item.externalId)).externalId
            : item.externalId
          await documents.linkToBlock(blockId, source, externalId)
        } else {
          const source = item.source as TaskSourceKind
          const externalId = item.needsImport
            ? (await tasks.importTask(source, item.externalId)).externalId
            : item.externalId
          await tasks.linkToBlock(blockId, source, externalId)
        }
      } catch {
        failed++
      }
    }
    return failed
  }

  return { linkPending }
}
