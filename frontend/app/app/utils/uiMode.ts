/**
 * The interface tier the SPA renders at: `basic` shows the everyday surface, `advanced`
 * shows every destination and every run/pipeline option. Pure resolution logic, kept out
 * of the store so it is testable without Pinia or a Nuxt runtime.
 *
 * Precedence is fixed and NOT negotiable per surface: the deployment's env value always
 * wins over the browser-stored user choice, which wins over the `basic` default. That
 * ordering is what lets an operator pin a fleet of kiosk-ish deployments to one tier
 * without a per-browser reset, so `setMode` is a no-op while the env pin is present
 * rather than writing a preference the resolver would then ignore.
 */
export const UI_MODES = ['basic', 'advanced'] as const

export type UiMode = (typeof UI_MODES)[number]

/** The tier a deployment gets when neither env nor the browser says otherwise. */
export const DEFAULT_UI_MODE: UiMode = 'basic'

/**
 * Coerce an untrusted value (a `NUXT_PUBLIC_UI_MODE` string baked into the bundle, or a
 * restored cookie/localStorage value) to a known mode. Anything unrecognised — including
 * the empty string the runtime-config default carries when the env var is unset — resolves
 * to `null`, i.e. "this layer has no opinion", so the next one down decides. Never throws:
 * a typo'd env value must degrade to the default rather than fail the boot.
 */
export function parseUiMode(raw: unknown): UiMode | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  return (UI_MODES as readonly string[]).includes(value) ? (value as UiMode) : null
}

/** Apply the precedence: env pin → browser-stored user choice → {@link DEFAULT_UI_MODE}. */
export function resolveUiMode(env: UiMode | null, stored: UiMode | null): UiMode {
  return env ?? stored ?? DEFAULT_UI_MODE
}
