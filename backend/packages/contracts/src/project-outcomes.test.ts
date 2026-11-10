import { describe, expect, it } from 'vitest'
import { decodeOutcomeStoragePolicy } from './project-outcomes.js'

describe('decodeOutcomeStoragePolicy', () => {
  it('reads a stored policy and refuses one outside the schema', () => {
    expect(decodeOutcomeStoragePolicy('{"inlineMaxBytes":1000,"offload":"disabled"}')).toEqual({
      inlineMaxBytes: 1000,
      offload: 'disabled',
    })
    expect(() => decodeOutcomeStoragePolicy('{"inlineMaxBytes":-1}')).toThrow()
    expect(() => decodeOutcomeStoragePolicy('{"offload":"sometimes"}')).toThrow()
  })
})
