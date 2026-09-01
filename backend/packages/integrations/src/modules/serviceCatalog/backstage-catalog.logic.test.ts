import { describe, expect, it } from 'vitest'
import {
  type BackstageEntity,
  apiContractFormatForType,
  composeDescription,
  entityCapabilities,
  entityRef,
  entitySummary,
  formatEntityRef,
  ownerLabel,
  parseEntityRef,
  providedApiRefs,
  serviceIdForEntity,
  slugify,
  toServiceCatalogApi,
  toServiceCatalogEntry,
} from './backstage-catalog.logic.js'

const component = (overrides: BackstageEntity = {}): BackstageEntity => ({
  kind: 'Component',
  metadata: { name: 'orders', ...overrides.metadata },
  spec: { type: 'service', owner: 'group:default/payments', ...overrides.spec },
  ...(overrides.kind ? { kind: overrides.kind } : {}),
})

describe('parseEntityRef', () => {
  it('reads the canonical form', () => {
    expect(parseEntityRef('component:default/orders', 'api')).toEqual({
      kind: 'component',
      namespace: 'default',
      name: 'orders',
    })
  })

  it('fills the kind from the field a compact reference appeared in', () => {
    // `providesApis: [orders-api]` and `owner: payments` are what a hand-written
    // catalog-info.yaml holds; the kind is implied by the field, not the string.
    expect(parseEntityRef('orders-api', 'api')?.kind).toBe('api')
    expect(parseEntityRef('payments', 'group')?.kind).toBe('group')
  })

  it('defaults the namespace and lowercases the kind', () => {
    expect(parseEntityRef('API:Orders', 'component')).toEqual({
      kind: 'api',
      namespace: 'default',
      name: 'Orders',
    })
  })

  it('refuses a reference with no name', () => {
    expect(parseEntityRef('api:default/', 'api')).toBeNull()
    expect(parseEntityRef('   ', 'api')).toBeNull()
  })

  it('round-trips through the canonical rendering', () => {
    const ref = parseEntityRef('payments/orders', 'api')
    expect(ref && formatEntityRef(ref)).toBe('api:payments/orders')
  })
})

describe('serviceIdForEntity', () => {
  it('slugs the name', () => {
    expect(serviceIdForEntity(component({ metadata: { name: 'Orders.API_v2' } }))).toBe(
      'orders-api-v2',
    )
  })

  it('leaves the default namespace off', () => {
    expect(
      serviceIdForEntity(component({ metadata: { name: 'orders', namespace: 'default' } })),
    ).toBe('orders')
  })

  it('prefixes a non-default namespace so two teams cannot collapse onto one id', () => {
    const alpha = component({ metadata: { name: 'api', namespace: 'team-alpha' } })
    const beta = component({ metadata: { name: 'api', namespace: 'team-beta' } })
    expect(serviceIdForEntity(alpha)).toBe('team-alpha-api')
    expect(serviceIdForEntity(beta)).toBe('team-beta-api')
    expect(serviceIdForEntity(alpha)).not.toBe(serviceIdForEntity(beta))
  })

  it('refuses a name with nothing slug-shaped in it', () => {
    expect(serviceIdForEntity(component({ metadata: { name: '///' } }))).toBeNull()
  })
})

describe('slugify', () => {
  it('caps at the catalog id limit without leaving a trailing separator', () => {
    const slug = slugify(`${'a'.repeat(63)}-tail`)
    expect(slug).toHaveLength(63)
    expect(slug.endsWith('-')).toBe(false)
  })

  it('is stable for the same input', () => {
    expect(slugify('Payments Service')).toBe(slugify('payments--service'))
  })
})

describe('apiContractFormatForType', () => {
  it('maps the four types the platform serves a format for', () => {
    expect(apiContractFormatForType('openapi')).toBe('openapi')
    expect(apiContractFormatForType('AsyncAPI')).toBe('asyncapi')
    expect(apiContractFormatForType('graphql')).toBe('graphql')
    expect(apiContractFormatForType(' grpc ')).toBe('grpc')
  })

  it('answers null for a type the platform serves none for', () => {
    // The whole point: storing a `trpc` definition AS OpenAPI would produce a contract that
    // parses to zero operations and reads as a service that publishes nothing.
    expect(apiContractFormatForType('trpc')).toBeNull()
    expect(apiContractFormatForType(undefined)).toBeNull()
  })
})

describe('ownerLabel', () => {
  it('renders the recognisable name beside the lookup-able reference', () => {
    expect(ownerLabel('group:default/payments')).toBe('payments (group:default/payments)')
  })

  it('reads a compact owner as a group', () => {
    expect(ownerLabel('payments')).toBe('payments (group:default/payments)')
  })

  it('answers null when there is no owner', () => {
    expect(ownerLabel(undefined)).toBeNull()
    expect(ownerLabel('  ')).toBeNull()
  })
})

describe('composeDescription', () => {
  it('puts ownership first and the prose after it', () => {
    const description = composeDescription(
      component({
        metadata: {
          name: 'orders',
          description: 'Places and tracks customer orders.',
          links: [{ url: 'https://runbook.example/orders', title: 'Runbook' }],
          annotations: {
            'backstage.io/source-location': 'url:https://github.com/acme/orders/',
            'backstage.io/techdocs-ref': 'dir:.',
          },
        },
        spec: {
          type: 'service',
          owner: 'group:default/payments',
          system: 'checkout',
          domain: 'commerce',
          lifecycle: 'production',
        },
      }),
    )
    expect(description.split('\n')[0]).toBe('Owner: payments (group:default/payments)')
    expect(description).toContain('System: checkout')
    expect(description).toContain('Domain: commerce')
    expect(description).toContain('Lifecycle: production')
    expect(description).toContain('Source: url:https://github.com/acme/orders/')
    expect(description).toContain('Docs: dir:.')
    expect(description).toContain('Links: Runbook (https://runbook.example/orders)')
    expect(description).toContain('Places and tracks customer orders.')
  })

  it('states that the owner is not recorded rather than omitting the line', () => {
    // Omitting it would read as a service whose ownership the reader simply did not look for.
    expect(composeDescription(component({ spec: { owner: undefined } }))).toContain(
      'Owner: not recorded in the catalog',
    )
  })

  it('drops PROSE rather than the ownership facts when the cap bites', () => {
    const description = composeDescription(
      component({ metadata: { name: 'orders', description: 'x'.repeat(30_000) } }),
    )
    expect(description).toHaveLength(20_000)
    expect(description.startsWith('Owner: payments')).toBe(true)
  })
})

describe('entitySummary', () => {
  it('uses the first line of the description', () => {
    expect(
      entitySummary(component({ metadata: { name: 'orders', description: 'Orders.\nMore.' } })),
    ).toBe('Orders.')
  })

  it('falls back to the facts the entity does carry', () => {
    expect(entitySummary(component({ metadata: { name: 'orders' } }))).toBe(
      'service owned by payments (group:default/payments)',
    )
  })

  it('says so when there is neither a description nor an owner', () => {
    expect(
      entitySummary(
        component({ metadata: { name: 'orders' }, spec: { type: 'website', owner: undefined } }),
      ),
    ).toBe('website with no recorded owner')
  })
})

describe('entityCapabilities', () => {
  it('folds the tags and the declared type into one de-duplicated list', () => {
    expect(
      entityCapabilities(
        component({ metadata: { name: 'orders', tags: ['Payments', 'service', 'payments'] } }),
      ),
    ).toEqual(['payments', 'service'])
  })

  it('refuses a RESERVED platform tag from an external portal', () => {
    // `asset-storage` makes a service selectable as a binary-output storage target, so accepting
    // it from a catalog-info.yaml would enrol a component into a platform capability nobody here
    // chose.
    expect(
      entityCapabilities(component({ metadata: { name: 'orders', tags: ['asset-storage'] } })),
    ).toEqual(['service'])
  })

  it('refuses a NEAR-MISS of a reserved tag', () => {
    expect(
      entityCapabilities(component({ metadata: { name: 'orders', tags: ['assetstorage'] } })),
    ).toEqual(['service'])
  })
})

describe('providedApiRefs', () => {
  it('canonicalises and de-duplicates', () => {
    expect(
      providedApiRefs(
        component({
          spec: { providesApis: ['orders-api', 'api:default/orders-api', 'payments/billing'] },
        }),
      ),
    ).toEqual(['api:default/orders-api', 'api:payments/billing'])
  })

  it('is empty when the component declares none', () => {
    expect(providedApiRefs(component())).toEqual([])
  })
})

describe('toServiceCatalogApi', () => {
  const api = (spec: BackstageEntity['spec']): BackstageEntity => ({
    kind: 'API',
    metadata: { name: 'orders-api', title: 'Orders API', etag: 'e1' },
    spec,
  })

  it('maps an OpenAPI entity', () => {
    expect(toServiceCatalogApi(api({ type: 'openapi', definition: 'openapi: 3.0.0' }))).toEqual({
      id: 'orders-api',
      title: 'Orders API',
      format: 'openapi',
      definition: 'openapi: 3.0.0',
      ref: 'api:default/orders-api',
      revision: 'e1',
    })
  })

  it('refuses an entity with no definition', () => {
    expect(toServiceCatalogApi(api({ type: 'openapi' }))).toBeNull()
    expect(toServiceCatalogApi(api({ type: 'openapi', definition: '   ' }))).toBeNull()
  })

  it('refuses a definition past the storage ceiling', () => {
    expect(
      toServiceCatalogApi(api({ type: 'openapi', definition: 'x'.repeat(1_000_001) })),
    ).toBeNull()
  })

  it('refuses a type the platform serves no format for', () => {
    expect(toServiceCatalogApi(api({ type: 'sql', definition: 'select 1' }))).toBeNull()
  })

  it('prefixes the NAMESPACE onto the id, so two same-named interfaces stay two', () => {
    // `payments/orders` and `billing/orders` are different API entities whose names are equal. An
    // id from the name alone collapses them onto one contract, and the second is then dropped by
    // the importer with only a counter to say so.
    const scoped = (namespace: string) => ({
      kind: 'API',
      metadata: { name: 'orders', namespace },
      spec: { type: 'openapi', definition: 'openapi: 3.0.0' },
    })
    expect(toServiceCatalogApi(scoped('payments'))?.id).toBe('payments-orders')
    expect(toServiceCatalogApi(scoped('billing'))?.id).toBe('billing-orders')
    // The default namespace is left off, exactly as it is for a component id.
    expect(toServiceCatalogApi(scoped('default'))?.id).toBe('orders')
  })
})

describe('toServiceCatalogEntry', () => {
  it('carries the entity reference as provenance', () => {
    const entry = toServiceCatalogEntry(component({ metadata: { name: 'orders' } }), [])
    expect(entry?.ref).toBe('component:default/orders')
    expect(entry?.id).toBe('orders')
    expect(entry?.name).toBe('orders')
  })

  it('prefers the title for the display name', () => {
    const entry = toServiceCatalogEntry(
      component({ metadata: { name: 'orders', title: 'Orders Service' } }),
      [],
    )
    expect(entry?.name).toBe('Orders Service')
  })

  it('refuses an entity with no usable identity', () => {
    expect(toServiceCatalogEntry({ kind: 'Component', metadata: {} }, [])).toBeNull()
  })
})

describe('entityRef', () => {
  it('defaults the kind to component', () => {
    expect(entityRef({ metadata: { name: 'orders' } })).toBe('component:default/orders')
  })

  it('is null with no name', () => {
    expect(entityRef({ kind: 'Component', metadata: {} })).toBeNull()
  })

  it('lower-cases the NAMESPACE as well as the kind, matching every parsed reference', () => {
    // A reference the platform builds from a `providesApis` string resolves to the lower-cased
    // form, so an upper-cased namespace here would store provenance that addresses nothing.
    expect(
      entityRef({ kind: 'Component', metadata: { name: 'orders', namespace: 'Payments' } }),
    ).toBe('component:payments/orders')
    expect(formatEntityRef(parseEntityRef('Component:Payments/orders', 'component')!)).toBe(
      'component:payments/orders',
    )
  })
})
