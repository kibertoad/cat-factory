import type { DocumentSourceKind, TaskSourceKind } from '~/types/domain'
import { apiErrorEnvelope, apiErrorStatus } from './api/errors'

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
  /**
   * The item's body/description (Markdown), when known. Populated for an
   * already-imported issue at pick time and resolved (by importing) for a search
   * hit when the add-task form opens, so the form can surface it read-only and
   * fold it into the new task's description. Absent until resolved.
   */
  description?: string
  /** True when the item must be imported before it can be linked. */
  needsImport: boolean
}

/**
 * A single pending attachment that failed to import or link, captured with its
 * actual cause instead of swallowed. The message is the server's own explanation
 * (e.g. "GitHub denied access to …" / "… was not found on the default branch"),
 * the status is the HTTP code, and the code is the backend error code
 * (`conflict` / `validation` / …) — enough to both display a specific reason and
 * assemble a copy-pasteable diagnostic report.
 */
export interface LinkFailure {
  item: PendingContext
  /** The server's message (or a network-fault message) explaining why it failed. */
  message: string
  /** HTTP status of the failed request, when the error carried one. */
  status?: number
  /** Backend error code (`conflict` / `validation` / …), when present. */
  code?: string
}

/** Stable key for a pending item, used for dedupe + selection toggles. */
export function contextKey(c: Pick<PendingContext, 'kind' | 'source' | 'externalId'>): string {
  return `${c.kind}:${c.source}:${c.externalId}`
}

/**
 * Render a batch of {@link LinkFailure}s into a single plain-text diagnostic block
 * for the clipboard — the exact context a bug report needs (the item coordinates,
 * the HTTP status + backend code, and the server's message) so the user does not
 * have to retype any of it. Deliberately English/technical (a log dump, not UI
 * prose), mirroring how format/code examples stay out of the i18n catalog.
 */
export function buildLinkFailureReport(
  failures: LinkFailure[],
  context: { workspaceId?: string | null; blockId?: string; when?: string } = {},
): string {
  const lines: string[] = []
  lines.push(`Context link failures: ${failures.length}`)
  if (context.when) lines.push(`when: ${context.when}`)
  if (context.workspaceId) lines.push(`workspace: ${context.workspaceId}`)
  if (context.blockId) lines.push(`block: ${context.blockId}`)
  for (const f of failures) {
    lines.push('')
    lines.push(`- ${f.item.kind}/${f.item.source}: ${f.item.externalId}`)
    lines.push(`  title: ${f.item.title}`)
    if (f.status !== undefined) lines.push(`  status: ${f.status}`)
    if (f.code) lines.push(`  code: ${f.code}`)
    lines.push(`  error: ${f.message}`)
  }
  return lines.join('\n')
}

export function useContextLinking() {
  const documents = useDocumentsStore()
  const tasks = useTasksStore()
  const workspace = useWorkspaceStore()
  const toast = useToast()
  const { t } = useI18n()
  const { copyAction } = useCopyToClipboard()

  /**
   * Import (when needed) then link every pending item to `blockId`. Each failure
   * is captured with its actual cause rather than aborting the batch, so one bad
   * attachment doesn't sink the rest; returns the failures (empty ⇒ all linked).
   */
  async function linkPending(blockId: string, items: PendingContext[]): Promise<LinkFailure[]> {
    const failures: LinkFailure[] = []
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
      } catch (e) {
        // Never swallow the cause: capture the server's own message + status/code so the
        // toast can name the specific reason and the copy affordance can carry the context.
        failures.push({
          item,
          message: e instanceof Error ? e.message : String(e),
          status: apiErrorStatus(e),
          code: apiErrorEnvelope(e)?.code,
        })
      }
    }
    return failures
  }

  /**
   * Surface link failures as a single actionable toast: the specific per-item
   * reasons as the body, and a "Copy details" action that puts the full diagnostic
   * report ({@link buildLinkFailureReport}) on the clipboard. Sticky (`duration: 0`)
   * so the cause stays readable long enough to act on. No-op when nothing failed.
   */
  function presentLinkFailures(failures: LinkFailure[], blockId?: string): void {
    if (failures.length === 0) return
    const description = failures.map((f) => `${f.item.title}: ${f.message}`).join('\n')
    const report = buildLinkFailureReport(failures, {
      workspaceId: workspace.workspaceId,
      blockId,
      when: new Date().toISOString(),
    })
    toast.add({
      title: t('board.addTask.linkFailed', { count: failures.length }, failures.length),
      description,
      icon: 'i-lucide-triangle-alert',
      color: 'warning',
      duration: 0,
      actions: [copyAction(report)],
    })
  }

  return { linkPending, presentLinkFailures }
}
