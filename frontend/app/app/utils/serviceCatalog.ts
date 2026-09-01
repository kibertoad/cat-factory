import type { ServiceCatalogAuthMode, ServiceCatalogSyncStatus } from '~/types/domain'

// The SERVICE CATALOG connection's two closed vocabularies → their i18n keys, in ONE place each.
//
// Here rather than inline in `ServiceCatalogConnection.vue` for the reason `utils/vcs.ts` holds the
// per-provider constants: an exhaustive `Record` over a wire union is the drift guard, and it only
// guards if there is exactly one of it. A second copy in a template would keep rendering while this
// one gained a member.
//
// Both are also the case the typed-message-key guard cannot see: the keys are reached through a
// lookup rather than written as a literal `t('a.b.c')`, so nothing proves the entry still names a
// key that exists. `serviceCatalog.spec.ts` asserts every value against the base catalog, which is
// the convention `test/i18nKeys.ts` exists for.

/**
 * The label for one authentication mode.
 *
 * The keys are camelCase where the wire values are kebab-case, because a vue-i18n path segment is
 * read as a nested lookup and a hyphen in one reads fine but breaks the moment anyone writes the
 * literal form.
 */
export const SERVICE_CATALOG_AUTH_KEYS: Record<ServiceCatalogAuthMode, string> = {
  none: 'serviceCatalog.auth.none',
  'static-token': 'serviceCatalog.auth.staticToken',
  'legacy-shared-secret': 'serviceCatalog.auth.legacySharedSecret',
  'oauth2-client-credentials': 'serviceCatalog.auth.oauth2',
  basic: 'serviceCatalog.auth.basic',
  headers: 'serviceCatalog.auth.headers',
}

/**
 * The label for what the last import concluded.
 *
 * `never` is NOT a member of the wire union and has its own key beside these: "no import has run"
 * is a null `lastSyncStatus` rather than a status value, and collapsing it into `failed` would tell
 * an operator their portal is broken the moment they connect it.
 */
export const SERVICE_CATALOG_STATUS_KEYS: Record<ServiceCatalogSyncStatus, string> = {
  ok: 'serviceCatalog.status.ok',
  partial: 'serviceCatalog.status.partial',
  failed: 'serviceCatalog.status.failed',
}

/** The key for a connection's last verdict, including the "never imported" case. */
export function serviceCatalogStatusKey(status: ServiceCatalogSyncStatus | null): string {
  return status ? SERVICE_CATALOG_STATUS_KEYS[status] : 'serviceCatalog.status.never'
}

/**
 * The badge colour for one verdict. `partial` is a WARNING rather than a success, which is the
 * whole point of the three-value status: a truncated import holds real services and not all of
 * them, and a green badge over it is how a prefix of an estate comes to read as the estate.
 */
export const SERVICE_CATALOG_STATUS_COLORS = {
  ok: 'success',
  partial: 'warning',
  failed: 'error',
} as const satisfies Record<ServiceCatalogSyncStatus, string>

/** The modes offered in the connect form, in the order an operator is most likely to want them. */
export const SERVICE_CATALOG_AUTH_ORDER: readonly ServiceCatalogAuthMode[] = [
  'static-token',
  'legacy-shared-secret',
  'oauth2-client-credentials',
  'basic',
  'headers',
  'none',
]
