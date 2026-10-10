import type { BinaryGeneratorCapability } from '@cat-factory/contracts'
import {
  binaryGeneratorCapabilitySchema,
  isReservedPlatformEnvKey,
  isToolchainEnvName,
  modalitiesOfMediaType,
} from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { NANO_BANANA_OPENAPI } from '../contracts/nano-banana.openapi.js'
import { NANO_BANANA_CREDENTIAL_KEY, nanoBananaGenerator } from './nano-banana.js'

// ---------------------------------------------------------------------------
// What holds the DECLARATION and the DOCUMENT together.
//
// The definition beside this file makes claims about an endpoint ("this API can be asked for a
// seed", "it takes these ten ratios"), and nothing in the type system connects a claim to the
// OpenAPI document the agent is actually handed. Both halves go wrong quietly and in opposite
// directions: a capability declared for a parameter the contract does not carry admits a step and
// then leaves the agent with an option it cannot send, while a parameter the contract carries and
// the definition omits refuses a step this integration would have served.
//
// So the assertions here are RELATIONS over the two, never a second hand-written copy of either.
// The one thing they cannot check is semantics: a `seed` field in the document is evidence that
// the capability is spellable, not proof that Google reads it as a seed. What they catch is what
// actually happens, which is one half edited without the other moving.
// ---------------------------------------------------------------------------

/** The document as the registry stores it: one string, which is also what the agent reads. */
const serialized = JSON.stringify(NANO_BANANA_OPENAPI)

/**
 * Where each declared capability LIVES in the contract: the request field that carries it.
 *
 * Every declared capability must appear here, which the first test enforces from the definition's
 * own list rather than from this table, so adding a capability without naming its evidence fails.
 */
const CAPABILITY_CONTRACT_FIELDS: Partial<Record<BinaryGeneratorCapability, readonly string[]>> = {
  // `image` blocks in `input`, and the cap that makes several of them one request.
  'reference-image': ['ImageInput'],
  'multi-reference': ['up to 14'],
  // Editing is the same operation: an image block plus the text saying what to change.
  'instruction-edit': ['ImageInput', 'TextInput'],
  seed: ['seed'],
  'aspect-ratio': ['aspect_ratio'],
}

describe('nano-banana', () => {
  it('names its evidence in the contract for every capability it declares', () => {
    for (const capability of nanoBananaGenerator.capabilities) {
      const fields = CAPABILITY_CONTRACT_FIELDS[capability]
      expect(fields, `capability "${capability}" names no contract evidence`).toBeDefined()
      for (const field of fields ?? []) {
        expect(serialized, `capability "${capability}" cites "${field}"`).toContain(field)
      }
    }
  })

  it('declares only capabilities the platform still defines', () => {
    // Derived from the picklist the platform branches on rather than a list written out here: a
    // member retired upstream fails this on the version bump instead of registering a tag that
    // silently never matches.
    const vocabulary = new Set<string>(binaryGeneratorCapabilitySchema.options)
    for (const capability of nanoBananaGenerator.capabilities) {
      expect(vocabulary.has(capability), `"${capability}" is not a capability`).toBe(true)
    }
  })

  it('accepts exactly the aspect ratios the contract enumerates', () => {
    // The definition's `accepts` set and the document's enum are one fact stated twice, and this
    // is the assertion that keeps them one. Read out of the document rather than restated, so a
    // ratio Google adds or drops moves both halves together or fails here.
    const schemas = (NANO_BANANA_OPENAPI as any).components.schemas
    const documented: string[] = schemas.ImageResponseFormat.properties.aspect_ratio.enum
    expect([...(nanoBananaGenerator.accepts?.aspectRatios ?? [])].sort()).toEqual(
      [...documented].sort(),
    )
  })

  it('emits exactly the media types the contract lets a step ask for', () => {
    const schemas = (NANO_BANANA_OPENAPI as any).components.schemas
    const documented: string[] = schemas.ImageResponseFormat.properties.mime_type.enum
    expect([...nanoBananaGenerator.mediaTypes].sort()).toEqual([...documented].sort())
    // …and each of them is an `image`, which is the modality half of the same claim: the platform
    // classifies a media type independently, and a declaration the classifier disagrees with is a
    // step admitted for one job and asked to do another.
    for (const mediaType of nanoBananaGenerator.mediaTypes) {
      expect(modalitiesOfMediaType(mediaType)).toContain('image')
    }
  })

  it('looks its credential up under a key the platform does not own', () => {
    expect(nanoBananaGenerator.credentials.map((credential) => credential.key)).toEqual([
      NANO_BANANA_CREDENTIAL_KEY,
    ])
    // Asserted rather than assumed, because the failure is silent in the worst way: a key inside a
    // reserved family resolves NOTHING, and "no credential" is indistinguishable from an unset
    // variable at every layer that could report it. `GEMINI_API_KEY` is outside the set today; the
    // day a platform variable claims that family, this fails instead of the integration.
    expect(isReservedPlatformEnvKey(NANO_BANANA_CREDENTIAL_KEY)).toBe(false)
    // The other name, held to the narrower rule: a value injected under a toolchain variable
    // reconfigures the agent's process instead of authenticating a call. The two names are the
    // same string here, which is exactly why both rules are worth asserting on it.
    expect(isToolchainEnvName(NANO_BANANA_CREDENTIAL_KEY)).toBe(false)
  })

  it('registers its contract as a parseable document with the endpoint it declares', () => {
    const contract = nanoBananaGenerator.contracts[0]
    expect(contract?.format).toBe('openapi')
    const parsed = JSON.parse(contract?.body ?? '{}')
    expect(parsed.servers?.[0]?.url).toBe(nanoBananaGenerator.endpoint)
  })
})
