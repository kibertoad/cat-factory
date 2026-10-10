import type {
  DocumentFreshnessChange,
  DocumentFreshnessGap,
  DocumentRenderStatus,
} from '~/types/domain'

/**
 * The i18n keys `DocumentSyncState` renders a freshness verdict through, in their own module so a
 * spec can prove they still resolve.
 *
 * Both are exhaustive `Record`s over a contracts vocabulary, which buys half the guarantee: adding a
 * member fails the build here rather than rendering an empty line. The other half is what the
 * `satisfies` cannot see: that each VALUE still names a key the catalog holds. Typed message keys
 * and `i18n:check` only find keys written literally as a translate call, so a key held in a lookup
 * table is invisible to both, and deleting it reads as a clean removal that renders its own key path
 * at runtime. `DocumentSyncState.logic.spec.ts` closes that (see `test/i18nKeys.ts`).
 *
 * ONE FULL SENTENCE per member rather than a shared "not confirmed: {reason}" frame, because each
 * asks for a different fix and a clause spliced into a sentence is what breaks first in a language
 * whose word order is not English's.
 */
export const GAP_KEYS = {
  not_connected: 'documents.freshness.gap.not_connected',
  credentials_unreadable: 'documents.freshness.gap.credentials_unreadable',
  unversioned: 'documents.freshness.gap.unversioned',
  source_unreachable: 'documents.freshness.gap.source_unreachable',
} as const satisfies Record<DocumentFreshnessGap, string>

/**
 * What a CONFIRMED check found, which is a different question from why one failed.
 *
 * Three outcomes rather than a "did it change" boolean, because the middle one is the common case
 * for a whole-file source and is exactly what a boolean gets wrong: a Figma file's revision moves on
 * any edit anywhere in it, so a check legitimately finds a newer revision with not one byte of THIS
 * document's content different. Rendering that as "pulled the newer version" would tell a person
 * their own edit had landed when it may be in a frame this document does not cover.
 */
export const CHANGE_KEYS = {
  unchanged: 'documents.freshness.change.unchanged',
  reimported: 'documents.freshness.change.reimported',
  revision_only: 'documents.freshness.change.revision_only',
} as const satisfies Record<DocumentFreshnessChange, string>

/**
 * What became of a design document's rendered images, for the three statuses that ask something of
 * a person, and `null` for the two that do not.
 *
 * A design import retains its frames as reference images, and every way of failing to renders as
 * the same absence: no picture. `stored` and `none` are the states nothing can be done about
 * ("they are there" and "the design had none"), so they say nothing on an eleven-pixel line already
 * carrying a stamp, a verdict and a button. The other three each name a DIFFERENT fix, which is
 * exactly why they are worth the room: configure image storage, or retry a source that would not
 * render.
 *
 * `null` here rather than an omitted key so the `satisfies` still spans the whole vocabulary: a new
 * status has to be classified rather than falling silently into the unremarkable half.
 */
export const RENDER_STATUS_KEYS = {
  stored: null,
  none: null,
  partial: 'documents.renders.partial',
  failed: 'documents.renders.failed',
  storage_unavailable: 'documents.renders.storage_unavailable',
} as const satisfies Record<DocumentRenderStatus, string | null>
