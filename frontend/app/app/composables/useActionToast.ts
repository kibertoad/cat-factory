/**
 * The toast for everything that is NOT a failed call: the second of the SPA's two toast funnels.
 * A failed call goes to `usePipelineErrorToast().present(error, titleKey)`; every other toast comes
 * from here, so `toast.add` is called from exactly those two composables
 * (`scripts/check-frontend-feedback.mjs` enforces it).
 *
 * Each tone fixes its colour, its icon and whether it auto-dismisses, so two toasts of one tone
 * render identically wherever they come from. The call site picks a TONE and supplies COPY; it
 * cannot restyle the toast. Before this, some success toasts carried `color: 'success'` and some
 * none, and the icon was a choice made per site (`i-lucide-check`, `-link`, `-unplug`, `-copy`,
 * `-rocket`, or nothing).
 *
 * - `success`: the action the user asked for completed. Dismisses after Nuxt UI's default.
 * - `info`: progress or a state report that asks nothing of the reader ("drafting…", "up to
 *   date"). Dismisses after the default.
 * - `warning`: the action ran, but the outcome is partial or nothing changed in a way the reader
 *   should know about. Stays until closed, because it asks the reader to look at something.
 * - `error`: a refusal in TRANSLATED copy that is not a failed call: a client-side validation that
 *   never left the browser, or a recognised refusal reason the site maps to its own key. It has no
 *   envelope, so `present` would misread it as a network fault (README, "Every failure toast goes
 *   through ONE funnel"). Stays until closed, like every failure. A failure the backend reported
 *   as DATA with its own prose (a job row's `error`) is `presentReported` on the failure funnel
 *   instead, which keeps that prose as copyable detail rather than the headline.
 *
 * Titles are i18n KEYS, resolved here (the same contract as `present`), so a call site cannot hand
 * in untranslated prose as the headline. A `description` is already-resolved text, because it
 * often carries data (a repo name, a count line) built from several keys. A key handed in here is
 * invisible to typed message keys and to `vue-i18n-extract`, which only read a key written literally inside a `t()` call, so
 * `toastTitleKeys.spec.ts` resolves every literal key passed to either funnel against the catalog.
 */

/** One button on the toast. A call-to-action is content, so the call site may add one. */
export interface ActionToastAction {
  label: string
  icon?: string
  onClick: () => void
}

export interface ActionToastOptions {
  /** Interpolation for the title key. */
  params?: Record<string, unknown>
  /** The plural count for the title key, when it has plural forms. */
  plural?: number
  /** Resolved body text. */
  description?: string
  actions?: ActionToastAction[]
  /**
   * Offer an Undo for a write whose real effect is deferred. The toast then stays exactly as long
   * as the window the caller holds the write open for, because an Undo button that outlives the
   * window would undo nothing.
   */
  undo?: { run: () => void; windowMs: number }
}

type Tone = 'success' | 'info' | 'warning' | 'error'

// The only place a tone's look is decided. `duration: 0` keeps the toast until the reader closes
// it; `undefined` takes Nuxt UI's default (5s).
const TONES: Record<Tone, { color: Tone; icon: string; duration: number | undefined }> = {
  success: { color: 'success', icon: 'i-lucide-circle-check', duration: undefined },
  info: { color: 'info', icon: 'i-lucide-info', duration: undefined },
  warning: { color: 'warning', icon: 'i-lucide-triangle-alert', duration: 0 },
  error: { color: 'error', icon: 'i-lucide-triangle-alert', duration: 0 },
}

export function useActionToast() {
  const toast = useToast()
  // The Nuxt app's global i18n instance, not `useI18n()`: this is reached from store setup (the
  // board store's undo toasts) and from `useCopyToClipboard`, which the error funnel calls from
  // store setup. Same reason as `usePipelineErrorToast`.
  const { t } = useNuxtApp().$i18n as ReturnType<typeof useI18n>

  function show(tone: Tone, titleKey: string, opts: ActionToastOptions = {}): void {
    const look = TONES[tone]
    const params = opts.params ?? {}
    const title = opts.plural === undefined ? t(titleKey, params) : t(titleKey, params, opts.plural)
    const actions = [
      ...(opts.undo
        ? [{ label: t('common.undo'), icon: 'i-lucide-undo-2', onClick: opts.undo.run }]
        : []),
      ...(opts.actions ?? []),
    ]
    toast.add({
      title,
      description: opts.description,
      color: look.color,
      icon: look.icon,
      duration: opts.undo ? opts.undo.windowMs : look.duration,
      ...(actions.length ? { actions } : {}),
    })
  }

  return {
    success: (titleKey: string, opts?: ActionToastOptions) => show('success', titleKey, opts),
    info: (titleKey: string, opts?: ActionToastOptions) => show('info', titleKey, opts),
    warning: (titleKey: string, opts?: ActionToastOptions) => show('warning', titleKey, opts),
    error: (titleKey: string, opts?: ActionToastOptions) => show('error', titleKey, opts),
  }
}

export type ActionToast = ReturnType<typeof useActionToast>
