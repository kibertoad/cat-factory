import type { BinaryGeneratorDefinition } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  BinaryGeneratorRegistry,
  defaultBinaryGeneratorRegistry,
} from './binary-generator-registry.js'

// The app-owned seam a deployment registers its generative binary integrations through, and the
// last of the registry seams to get one. It carries the same three obligations as its siblings
// (empty on construction, later registration REPLACES, projection memoised but dropped on a
// write) plus one of its own: the views and the contract documents are built from ONE summary per
// contract, so an agent can never be handed a document whose operation list disagrees with the one
// its step was validated against.

const OPENAPI = 'openapi: 3.0.3\npaths:\n  /images:\n    post: {}\n  /jobs:\n    get: {}\n'

const definition = {
  id: 'acme-images',
  name: 'ACME Images',
  summary: 'Generates raster images from a prompt.',
  description: 'Good at product shots; not for photorealistic faces.',
  modalities: ['image'],
  mediaTypes: ['image/png'],
  endpoint: 'https://api.acme.example/v1',
  guidance: 'Poll /jobs until status is done.',
  credential: { key: 'ACME_IMAGES_API_KEY', header: 'Authorization' },
  contracts: [{ contractId: 'http', format: 'openapi' as const, title: 'HTTP API', body: OPENAPI }],
} as unknown as BinaryGeneratorDefinition

const registered = (...definitions: BinaryGeneratorDefinition[]) => {
  const registry = new BinaryGeneratorRegistry()
  registry.registerAll(definitions)
  return registry
}

describe('BinaryGeneratorRegistry', () => {
  it('is empty on construction, because the platform ships no generator', () => {
    // There is no image generator every organisation runs and every one of them is metered, so
    // the default selection set is empty and a step naming an id is refused at admission rather
    // than dispatching an agent that cannot generate.
    const registry = defaultBinaryGeneratorRegistry()
    expect(registry.all()).toEqual([])
    expect(registry.ids()).toEqual([])
    expect(registry.views()).toEqual([])
  })

  it('projects a registered integration with its contracts SUMMARISED, never their bodies', () => {
    // The views ride the engine's per-dispatch read and the workspace snapshot. A document body
    // here would put a whole OpenAPI file into both; the brief renderer fetches bodies separately
    // for exactly the ids a step selected.
    const [view] = registered(definition).views()
    expect(view).toMatchObject({
      id: 'acme-images',
      name: 'ACME Images',
      modalities: ['image'],
      mediaTypes: ['image/png'],
      endpoint: 'https://api.acme.example/v1',
      guidance: 'Poll /jobs until status is done.',
    })
    expect(view?.contracts[0]).toMatchObject({
      size: OPENAPI.length,
      // A code-registered definition has no repo provenance; naming one would be a fiction.
      path: null,
    })
    // Sorted, because the ORDER is `summarizeContract`'s to decide and its own suite's to pin.
    // What this registry owes is that every declared operation reaches the view.
    expect([...(view?.contracts[0]?.operations ?? [])].sort()).toEqual([
      'GET /jobs',
      'POST /images',
    ])
    expect(JSON.stringify(view)).not.toContain('openapi: 3.0.3')
  })

  it('carries the credential DECLARATION onto the view, and only the declaration', () => {
    // The key NAME is what the operator checklist renders. The value is resolved per dispatch on
    // the container executor's side and travels on the job body alone, so there is nothing here
    // for it to leak into.
    expect(registered(definition).views()[0]?.credential).toEqual({
      key: 'ACME_IMAGES_API_KEY',
      header: 'Authorization',
    })
  })

  it('omits an optional field rather than projecting it as empty or undefined', () => {
    // `endpoint`, `guidance` and `credential` are spread conditionally. "Not declared" and
    // "declared empty" are different facts to the brief renderer, and a key present with an
    // undefined value would survive `toMatchObject` while breaking the wire projection.
    const lean = { ...definition }
    for (const key of ['endpoint', 'guidance', 'credential', 'mediaTypes', 'contracts']) {
      delete (lean as unknown as Record<string, unknown>)[key]
    }
    const [view] = registered(lean).views()
    expect(view).not.toHaveProperty('endpoint')
    expect(view).not.toHaveProperty('guidance')
    expect(view).not.toHaveProperty('credential')
    // These two are always present: a list, defaulted to empty rather than dropped.
    expect(view?.mediaTypes).toEqual([])
    expect(view?.contracts).toEqual([])
  })

  it('copies the declared lists rather than aliasing the definition', () => {
    // The registry hands its projection to the engine per dispatch. Sharing the definition's own
    // arrays would let a consumer's in-place sort or splice rewrite what every later dispatch
    // reads, and nothing downstream would attribute it here.
    const [view] = registered(definition).views()
    expect(view?.modalities).not.toBe(definition.modalities)
    expect(view?.mediaTypes).not.toBe(definition.mediaTypes)
  })

  it('serves the SAME operation index with the document as the view showed', () => {
    // Both projections are built from one summary per contract, which is what makes this hold.
    const registry = registered(definition)
    const [document] = registry.documentsFor('acme-images')
    expect(document?.body).toBe(OPENAPI)
    expect(document?.operations).toEqual(registry.views()[0]?.contracts[0]?.operations)
  })

  it('answers an unregistered id with no documents rather than throwing', () => {
    expect(registered(definition).documentsFor('nope')).toEqual([])
  })

  it('lists definitions and ids in registration order, bodies included', () => {
    const second = {
      ...definition,
      id: 'acme-audio',
      modalities: ['audio'],
    } as BinaryGeneratorDefinition
    const registry = registered(definition, second)
    expect(registry.ids()).toEqual(['acme-images', 'acme-audio'])
    // `all()` is the boot-validation read, which needs the contract BODIES the views drop.
    expect(registry.all()[0]?.contracts?.[0]?.body).toBe(OPENAPI)
  })

  it('lets a later registration REPLACE an earlier one for the same id', () => {
    // How a deployment overrides an integration it inherited: it registers after, and the id must
    // not end up listed twice with the earlier definition still reachable.
    const registry = registered(definition)
    registry.register({ ...definition, name: 'ACME Images v2', contracts: [] })
    expect(registry.ids()).toEqual(['acme-images'])
    expect(registry.views()).toHaveLength(1)
    expect(registry.views()[0]?.name).toBe('ACME Images v2')
    // The memoised projection has to be dropped on a write, or the replacement is invisible to
    // every dispatch in a process that already resolved one.
    expect(registry.documentsFor('acme-images')).toEqual([])
  })

  it('memoises the projection until the next write', () => {
    // Building it parses every registered contract document, and a step's brief is resolved per
    // dispatch (per isolate on the Worker), so the identity is the point rather than an accident.
    const registry = registered(definition)
    expect(registry.views()).toBe(registry.views())
    registry.register({ ...definition, id: 'acme-audio' })
    expect(registry.views()).toHaveLength(2)
  })
})
