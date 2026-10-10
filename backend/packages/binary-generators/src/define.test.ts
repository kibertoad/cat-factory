import { describe, expect, it } from 'vitest'
import { defineBinaryGenerator, openApiContract } from './define.js'

// The seam's whole value is WHEN the platform's rules run: at import, so a bad definition is a
// failing test rather than a deployment that boots and rolls back. These cases are one per rule
// family, chosen so a rule that stopped being applied (a call dropped, an argument reordered)
// fails here rather than at somebody's boot.

const base = {
  id: 'acme-images',
  name: 'Acme Images',
  summary: 'Makes pictures.',
  description: 'Makes pictures for tests.',
  modalities: ['image'] as const,
}

describe('defineBinaryGenerator', () => {
  it('settles the optional collections so no consumer branches on undefined', () => {
    const generator = defineBinaryGenerator(base)
    expect(generator.mediaTypes).toEqual([])
    expect(generator.capabilities).toEqual([])
    expect(generator.contracts).toEqual([])
    expect(generator.credentials).toEqual([])
    // `accepts` is deliberately NOT settled: an absent record means "no set stated", while an
    // empty array inside one is refused, so manufacturing one would invent a refusal.
    expect(generator.accepts).toBeUndefined()
  })

  it('refuses a malformed definition through the schema the platform shares', () => {
    expect(() => defineBinaryGenerator({ ...base, id: 'Not A Slug' })).toThrow()
  })

  it('refuses a cleartext endpoint, which the credential would ride', () => {
    expect(() =>
      defineBinaryGenerator({
        ...base,
        endpoint: 'http://images.example.com',
        credentials: [{ key: 'ACME_IMAGE_KEY', usage: 'Authorization: Bearer <value>' }],
      }),
    ).toThrow(/https/)
  })

  it('refuses a media type whose modality contradicts the declared ones', () => {
    expect(() => defineBinaryGenerator({ ...base, mediaTypes: ['audio/mpeg'] })).toThrow(
      /modalities/,
    )
  })

  it('refuses an accepted-value set for an option no declared capability unlocks', () => {
    expect(() => defineBinaryGenerator({ ...base, accepts: { aspectRatios: ['16:9'] } })).toThrow(
      /aspect-ratio/,
    )
  })
})

describe('openApiContract', () => {
  it('serializes the document as the text the agent reads', () => {
    const contract = openApiContract({
      contractId: 'acme-api',
      title: 'Acme API',
      document: { openapi: '3.1.0' },
    })
    expect(contract.format).toBe('openapi')
    expect(JSON.parse(contract.body)).toEqual({ openapi: '3.1.0' })
  })
})
