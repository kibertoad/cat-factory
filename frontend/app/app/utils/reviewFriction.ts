import type { ReviewFrictionModalContext } from '~/stores/ui/modals'
import type { parseConflict } from '~/composables/usePipelineErrorToast'

/** A conflict `parseConflict` recognised. */
type ParsedConflict = NonNullable<ReturnType<typeof parseConflict>>

/** Whether a create was refused by the opt-in review-debt friction gate. */
export function isReviewDebtConflict(conflict: ParsedConflict | null): conflict is ParsedConflict {
  return conflict?.reason === 'review_debt_warn' || conflict?.reason === 'review_debt_blocked'
}

/**
 * Turn a parsed review-debt friction 409 into the dialog's context (see ReviewFrictionDialog.vue).
 *
 * Shared by every surface that creates a task, so the friction reads the same whichever form
 * raised it. `retry` re-submits with `acknowledgeReviewDebt` and is offered only on the soft
 * `warn` tier; `pending` is a GETTER over the opener's own in-flight flag, for the reason the
 * context type documents.
 */
export function reviewFrictionContext(
  conflict: ParsedConflict,
  retry: () => void,
  pending: () => boolean,
): ReviewFrictionModalContext {
  const details = conflict.details
  const rawDebt = Array.isArray(details.debt) ? details.debt : []
  const debt = rawDebt.map((d) => {
    const row = (d ?? {}) as { blockId?: unknown; title?: unknown; waitingMinutes?: unknown }
    return {
      blockId: typeof row.blockId === 'string' ? row.blockId : '',
      title: typeof row.title === 'string' ? row.title : null,
      waitingMinutes: typeof row.waitingMinutes === 'number' ? row.waitingMinutes : 0,
    }
  })
  const isWarn = conflict.reason === 'review_debt_warn'
  return {
    kind: isWarn ? 'warn' : 'blocked',
    reason:
      details.friction === 'count' || details.friction === 'stuck' ? details.friction : undefined,
    threshold: typeof details.threshold === 'number' ? details.threshold : null,
    debt,
    onConfirm: isWarn ? retry : null,
    pending,
  }
}
