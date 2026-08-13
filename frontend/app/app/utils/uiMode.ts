import type { RoleSurface } from '~/utils/uiRole'

/**
 * The interface tier the SPA renders at: `basic` shows the everyday surface, `advanced`
 * shows every destination and every run/pipeline option. Pure resolution logic, kept out
 * of the store so it is testable without Pinia or a Nuxt runtime.
 *
 * Precedence is fixed and NOT negotiable per surface: the ROLE's surface caps the tier, then
 * the deployment's env value wins over the browser-stored user choice, which wins over the
 * `basic` default. That ordering is what lets an operator pin a fleet of kiosk-ish deployments
 * to one tier without a per-browser reset, so `setMode` is a no-op while the env pin is present
 * rather than writing a preference the resolver would then ignore.
 */

export const UI_MODES = ['basic', 'advanced'] as const

export type UiMode = (typeof UI_MODES)[number]

/** The tier a deployment gets when neither env nor the browser says otherwise. */
export const DEFAULT_UI_MODE: UiMode = 'basic'

/**
 * The side-navbar rail state each tier STARTS in, before the user touches the toggle. Basic
 * opens railed (the icon rail is part of what makes it feel basic) and advanced opens
 * expanded. A default, not a rule: the preference is per-tier and remembered, so an explicit
 * choice in either tier survives both a reload and a round trip through the other tier.
 */
export const DEFAULT_RAIL_COLLAPSED: Record<UiMode, boolean> = { basic: true, advanced: false }

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

/**
 * Apply the precedence: the ROLE's surface as a ceiling, then env pin → browser-stored user
 * choice → {@link DEFAULT_UI_MODE}.
 *
 * The role (`utils/uiRole.ts`) sits ABOVE the env pin rather than beside it, because it is a
 * ceiling and not a preference: an `intake` role is offered the delivery surface and none of the
 * platform configuration behind it, and the advanced tier's whole content is that configuration.
 * Resolved here rather than by hiding the tier switcher alone, so every `isAdvanced` reader
 * inside a surface (the override fields, the authoring affordances) agrees with the nav
 * without each one restating the role.
 */
export function resolveUiMode(
  env: UiMode | null,
  stored: UiMode | null,
  surface: RoleSurface = 'full',
): UiMode {
  if (surface === 'intake') return 'basic'
  return env ?? stored ?? DEFAULT_UI_MODE
}

/**
 * An override value is SET when it deviates from the inherited default. `null`/`undefined`
 * (and the empty string a cleared picker writes) mean "inherit"; every other value — INCLUDING
 * `false`, which is a real choice on a tri-state like `technical` — is an explicit override.
 */
function isOverrideSet(value: unknown): boolean {
  return value != null && value !== ''
}

/**
 * Whether an OVERRIDE control is rendered at the current tier.
 *
 * Basic mode hides the controls whose only job is to override something already decided
 * elsewhere (a workspace-level default, an engine-inferred flag), which is safe ONLY while
 * what remains is exactly the value the hidden control would have shown. The moment a block
 * actually carries an override that stops being true: hiding it would leave a basic-mode user
 * looking at a task that runs on settings they cannot see, let alone clear — and nothing else
 * in the inspector surfaces them. So basic mode hides the control only while EVERY value it
 * edits is unset, and reveals it (exactly as advanced mode renders it, editable, so the
 * override can be cleared) as soon as one is not.
 *
 * Variadic because a single control can own several values — the tracker-writeback group edits
 * three tri-states behind one heading, and any one of them being set must reveal the group.
 */
export function showOverrideField(isAdvanced: boolean, ...values: readonly unknown[]): boolean {
  return isAdvanced || values.some(isOverrideSet)
}
