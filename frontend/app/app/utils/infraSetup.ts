import type { InfraSetupArea } from '~/types/domain'

// Shared vocabulary for the infra-setup banner's two card kinds, used by the banner itself and by
// the ui store's session-dismissal book-keeping.

/**
 * Which CLAIM an infra-setup card is making about an area. They share one banner surface but they
 * are not interchangeable, and every dismissal rule keys off the difference:
 *  - `setup` — "you never configured this". A stable operator decision, so it may be dismissed
 *    permanently as well as for the session.
 *  - `outage` — "you DID configure it, and a live probe cannot reach it". A health state, so it is
 *    session-dismissible only and must re-nag on recurrence.
 */
export type InfraSetupCardKind = 'setup' | 'outage'

/** A session-dismissal key: one area's one KIND of card. */
export type InfraSetupDismissalKey = `${InfraSetupArea}:${InfraSetupCardKind}`

/**
 * The session-dismissal key for one area's card kind. A composite key rather than a bare area,
 * because dismissing the setup nag must not silence the outage card that a later failure raises for
 * the same area — a different claim about a different state.
 */
export function infraSetupDismissalKey(
  area: InfraSetupArea,
  kind: InfraSetupCardKind,
): InfraSetupDismissalKey {
  return `${area}:${kind}`
}
