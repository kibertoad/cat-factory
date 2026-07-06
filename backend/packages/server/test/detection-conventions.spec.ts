import { describe, expect, it } from 'vitest'
import { parseDetectionConventions } from '../src/config/detection-conventions.js'

describe('parseDetectionConventions', () => {
  it('returns undefined for unset / blank / non-object / malformed input', () => {
    expect(parseDetectionConventions(undefined)).toBeUndefined()
    expect(parseDetectionConventions('')).toBeUndefined()
    expect(parseDetectionConventions('   ')).toBeUndefined()
    expect(parseDetectionConventions('not json')).toBeUndefined()
    expect(parseDetectionConventions('["array"]')).toBeUndefined()
    expect(parseDetectionConventions('"string"')).toBeUndefined()
    expect(parseDetectionConventions('42')).toBeUndefined()
    // A well-formed object with no recognized fields collapses to undefined (nothing to extend).
    expect(parseDetectionConventions('{"unknown":["x"]}')).toBeUndefined()
    // Empty arrays are dropped, leaving nothing.
    expect(parseDetectionConventions('{"composeFiles":[]}')).toBeUndefined()
  })

  it('reads the four known array fields, trimming blanks', () => {
    const parsed = parseDetectionConventions(
      JSON.stringify({
        composeFiles: ['stack.yml', ' compose.custom.yml '],
        composeDirs: ['infra'],
        seedDirs: ['ops/seeds'],
        envTemplateDirs: ['vault'],
      }),
    )
    expect(parsed).toEqual({
      composeFiles: ['stack.yml', 'compose.custom.yml'],
      composeDirs: ['infra'],
      seedDirs: ['ops/seeds'],
      envTemplateDirs: ['vault'],
    })
  })

  it('ignores non-string entries and unknown keys, keeping only populated fields', () => {
    const parsed = parseDetectionConventions(
      JSON.stringify({
        composeFiles: ['stack.yml', 42, null, ''],
        seedDirs: 'not-an-array',
        extra: 'ignored',
      }),
    )
    // seedDirs (non-array) is dropped; composeFiles keeps only the valid string.
    expect(parsed).toEqual({ composeFiles: ['stack.yml'] })
  })
})
