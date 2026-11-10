import { describe, expect, it } from 'vitest'
import { decodeOutcomeStoragePolicy, encodeOutcomeStoragePolicy } from './project-outcomes.js'

describe('decodeOutcomeStoragePolicy', () => {
  it('reads a stored policy and refuses one outside the schema', () => {
    expect(decodeOutcomeStoragePolicy('{"inlineMaxBytes":1000,"offload":"disabled"}')).toEqual({
      inlineMaxBytes: 1000,
      offload: 'disabled',
    })
    expect(() => decodeOutcomeStoragePolicy('{"inlineMaxBytes":-1}')).toThrow()
    expect(() => decodeOutcomeStoragePolicy('{"offload":"sometimes"}')).toThrow()
  })

  it('refuses to encode a policy it would refuse to read back', () => {
    expect(decodeOutcomeStoragePolicy(encodeOutcomeStoragePolicy({ offload: 'disabled' }))).toEqual(
      { offload: 'disabled' },
    )
    expect(() => encodeOutcomeStoragePolicy({ inlineMaxBytes: -1 })).toThrow()
  })
})
