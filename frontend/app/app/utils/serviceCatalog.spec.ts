import { describe, expect, it } from 'vitest'
import { missingI18nKeys } from '../../test/i18nKeys'
import {
  SERVICE_CATALOG_AUTH_KEYS,
  SERVICE_CATALOG_AUTH_ORDER,
  SERVICE_CATALOG_STATUS_COLORS,
  SERVICE_CATALOG_STATUS_KEYS,
  serviceCatalogStatusKey,
} from './serviceCatalog'

describe('service-catalog i18n keys', () => {
  // The gap `test/i18nKeys.ts` exists for: the exhaustive `Record` proves every union member has an
  // entry, and nothing proves the entry still names a key that exists. Deleting one would otherwise
  // read as a clean removal, with the badge rendering its own key path at runtime.
  it('every auth-mode key resolves in the base catalog', () => {
    expect(missingI18nKeys(Object.values(SERVICE_CATALOG_AUTH_KEYS))).toEqual([])
  })

  it('every status key resolves, the never-imported case included', () => {
    expect(
      missingI18nKeys([
        ...Object.values(SERVICE_CATALOG_STATUS_KEYS),
        serviceCatalogStatusKey(null),
      ]),
    ).toEqual([])
  })
})

describe('serviceCatalogStatusKey', () => {
  it('keeps "never imported" apart from a failure', () => {
    // Collapsing them would tell an operator their portal is broken the moment they connect it.
    expect(serviceCatalogStatusKey(null)).not.toBe(SERVICE_CATALOG_STATUS_KEYS.failed)
  })
})

describe('SERVICE_CATALOG_AUTH_ORDER', () => {
  it('offers exactly the modes the label map knows, once each', () => {
    // A relation over the two, not a pinned count: a new auth mode adds a member to the union, and
    // this fails until the form offers it and the label map names it.
    expect([...SERVICE_CATALOG_AUTH_ORDER].sort()).toEqual(
      Object.keys(SERVICE_CATALOG_AUTH_KEYS).sort(),
    )
  })
})

describe('SERVICE_CATALOG_STATUS_COLORS', () => {
  it('renders a PARTIAL import as a warning rather than a success', () => {
    expect(SERVICE_CATALOG_STATUS_COLORS.partial).toBe('warning')
    expect(SERVICE_CATALOG_STATUS_COLORS.ok).toBe('success')
  })
})
