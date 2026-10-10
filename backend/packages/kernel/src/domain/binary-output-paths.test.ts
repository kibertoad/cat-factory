import { describe, expect, it } from 'vitest'
// The IMPORT ORDER here is the test. `binary-outputs.js` FIRST, which is the side of the
// binary-outputs ⇄ binary-generators cycle that a real backend boot enters from — and the order
// under which a value derived across that cycle at module-init time throws
// `Cannot access 'BINARY_OUTPUT_CONTEXT_DIR' before initialization`. Every other spec in this
// package imports `binary-generators.js` first, which is why the crash reached CI as three dead
// e2e shards while 2000 unit tests passed.
import { BINARY_OUTPUT_BRIEF_FILE, BINARY_OUTPUT_CONTEXT_DIR } from './binary-outputs.js'
import { BINARY_GENERATOR_CONTEXT_DIR, binaryGeneratorContextFileFor } from './binary-generators.js'
import { binaryContextFileFor } from './binary-output-paths.js'

describe('the .cat-context/ path vocabulary', () => {
  it('evaluates when the cycle is entered from the binary-outputs side', () => {
    // If the constants were derived across the cycle again, this file would not even load — the
    // assertions are almost incidental. They are here so the failure names the constant rather
    // than appearing as an unexplained module-load error.
    expect(BINARY_OUTPUT_CONTEXT_DIR).toBe('binary-output')
    expect(BINARY_OUTPUT_BRIEF_FILE).toBe('binary-output/brief.md')
    expect(BINARY_GENERATOR_CONTEXT_DIR).toBe('binary-output/generators')
  })

  it('cannot collide a service id with a generative integration id', () => {
    // The reason generators get a directory rather than a `generator-` filename prefix: both ids
    // are the same lower-kebab slug grammar drawn from different registries, and a slug cannot
    // contain `/`.
    expect(binaryGeneratorContextFileFor('sprites')).toBe('binary-output/generators/sprites.md')
    expect(binaryContextFileFor('generator-sprites')).toBe('binary-output/generator-sprites.md')
    expect(binaryGeneratorContextFileFor('sprites')).not.toBe(
      binaryContextFileFor('generator-sprites'),
    )
  })
})
