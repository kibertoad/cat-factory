// ---------------------------------------------------------------------------
// The queue-first PREVIEW (issue #2258): a second shell for the same app, switched on per
// browser, so the home-surface decision can be made by using both rather than by reading
// wireframes.
//
// Off by default, and nothing changes while it is off: every surface the preview replaces
// (the advisory banners, the startup dialogs, the role and tour prompts) keeps its own
// behaviour unless `enabled` is true. That is what lets it ship on a branch beside the real
// board without a migration in either direction.
// ---------------------------------------------------------------------------

/**
 * The surfaces the preview's main area can show. `board` is the existing canvas, unchanged;
 * `queue` and `setup` are the two the preview adds.
 */
export const HOME_VIEWS = ['queue', 'board', 'setup'] as const
export type HomeView = (typeof HOME_VIEWS)[number]

/** Where the preview lands when it is switched on, and on every fresh load while it is on. */
export const DEFAULT_HOME_VIEW: HomeView = 'queue'

export function isHomeView(value: unknown): value is HomeView {
  return typeof value === 'string' && (HOME_VIEWS as readonly string[]).includes(value)
}

/** The query parameter that turns the preview on or off, so it can be handed over as a link. */
export const HOME_PREVIEW_PARAM = 'preview'

/**
 * What a `?preview=` value asks for: `true` to turn the preview on, `false` to turn it off,
 * `null` when the parameter is absent or says neither. `queue` is the documented value; `on`
 * and `1` are accepted because people type them.
 */
export function parsePreviewParam(value: string | null): boolean | null {
  if (value == null) return null
  const v = value.trim().toLowerCase()
  if (v === 'queue' || v === 'on' || v === '1' || v === 'true') return true
  if (v === 'off' || v === '0' || v === 'false' || v === 'board') return false
  return null
}
