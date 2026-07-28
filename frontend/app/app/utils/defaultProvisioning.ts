import type { CustomManifestType, ProvisionType, WorkspaceSettings } from '@cat-factory/contracts'

/**
 * The workspace-level default test-environment provisioning mechanism: what the SPA nags about
 * when it is unset, and what the config section preselects when the operator first opens it.
 *
 * Pure so both consumers — the banner's visibility and the section's initial selection — agree
 * on the same notion of "nothing chosen yet" without either re-deriving it.
 */

/**
 * The query param that deep-links straight to the default-provisioning config section
 * (`?settings=default-test-env`). Defined here — beside the logic both ends share — so the
 * banner that BUILDS the URL and the ui store that CONSUMES it can never drift; a mismatch
 * would produce a link that silently opens nothing.
 */
export const DEFAULT_PROVISION_DEEP_LINK_PARAM = 'settings'
export const DEFAULT_PROVISION_DEEP_LINK_VALUE = 'default-test-env'

/**
 * The shareable absolute URL for the config screen. Built from the CURRENT location (rather
 * than a configured base) so it is correct for whatever origin/path this SPA is actually served
 * from — a deployment mounted under a sub-path included. Returns just the query string when
 * there is no `window` (SSR is off, but the util stays callable in a unit test).
 */
export function defaultProvisioningConfigUrl(location?: {
  origin: string
  pathname: string
}): string {
  const query = `?${DEFAULT_PROVISION_DEEP_LINK_PARAM}=${DEFAULT_PROVISION_DEEP_LINK_VALUE}`
  const loc = location ?? (typeof window === 'undefined' ? undefined : window.location)
  return loc ? `${loc.origin}${loc.pathname}${query}` : query
}

/** The section's editable selection: a provision type plus, for `custom`, the pinned manifest id. */
export interface DefaultProvisioningSelection {
  type: ProvisionType | null
  manifestId: string | null
}

/**
 * Whether the workspace still owes a decision. `null` means the operator has never chosen —
 * distinct from an explicit `infraless` ("services stand up no environment"), which is a real
 * choice and silences the prompt. See the contracts block comment on `defaultProvisionType`.
 */
export function needsDefaultProvisioningChoice(
  settings: Pick<WorkspaceSettings, 'defaultProvisionType'>,
): boolean {
  return settings.defaultProvisionType == null
}

/**
 * The selection the config section opens on.
 *
 * A recorded choice always wins — the section is an editor for it, not a recommender that
 * overrides what the workspace already decided.
 *
 * With nothing recorded, a deployment that has REGISTERED custom providers is telling us it
 * brought its own environment tooling, and that tooling is almost always what its services
 * should use — so the first one is preselected rather than making the operator discover the
 * `custom` tab and then pick from a list only they can interpret. `registered` (code-defined,
 * shipped by the deployment) is preferred over `workspace` (a row somebody typed into the UI):
 * only the former is evidence of a deliberate platform-level integration. Falling back to the
 * first workspace-defined type keeps the suggestion useful on a board whose only custom type
 * was authored by hand.
 *
 * With no custom providers at all there is nothing to suggest, so the section opens UNSET and
 * the operator picks from the built-in types. It deliberately does not guess a built-in: unlike
 * a registered custom provider, the presence of `kubernetes` in the picker says nothing about
 * whether this workspace's services use it.
 *
 * Nothing here is persisted — this is the form's initial value, and the operator still saves.
 */
export function suggestDefaultProvisioning(
  settings: Pick<WorkspaceSettings, 'defaultProvisionType' | 'defaultProvisionManifestId'>,
  customTypes: readonly CustomManifestType[],
): DefaultProvisioningSelection {
  if (settings.defaultProvisionType != null) {
    return {
      type: settings.defaultProvisionType,
      manifestId: settings.defaultProvisionManifestId,
    }
  }
  const suggested =
    customTypes.find((t) => t.source === 'registered') ?? customTypes[0] ?? undefined
  return suggested
    ? { type: 'custom', manifestId: suggested.manifestId }
    : { type: null, manifestId: null }
}

/**
 * Whether a selection can be saved. Mirrors the server's cross-field rule so the button
 * disables instead of round-tripping to a 422: `custom` must name the manifest type it uses,
 * and there is nothing to save until a type is picked.
 */
export function canSaveDefaultProvisioning(selection: DefaultProvisioningSelection): boolean {
  if (selection.type == null) return false
  return selection.type !== 'custom' || !!selection.manifestId
}
