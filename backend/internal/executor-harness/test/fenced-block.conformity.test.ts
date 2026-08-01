import { fencedBlock } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { fencedOutput } from '../src/captured-command.js'

// `fencedOutput` is a deliberate COPY of kernel's `fencedBlock` (the container image is built
// from `src/` plus typescript alone, so the harness can carry no runtime dependency on a
// workspace package). Both exist to stop a body from breaking out of the block that holds it —
// captured command output on the harness side, an API contract document on the backend side —
// and a copy of that boundary is only acceptable if it cannot drift, so this suite pins the two
// to byte-identical output over the shapes that matter.

const CORPUS: Array<[name: string, input: string]> = [
  ['plain text', 'npm error could not resolve dependency'],
  ['empty', ''],
  ['a lone inline span', 'the literal `foo` stays quoted'],
  ['a three-tick fence', 'before\n```ts\nconst a = 1\n```\nafter'],
  ['an unbalanced three-tick fence', 'before\n```ts\nconst a = 1\n'],
  ['a four-tick fence', 'a\n````md\n```ts\nx\n```\n````\nb'],
  ['a six-tick run', 'weird ``````` output'],
  ['a run at the very start', '```\nleading fence\n'],
  ['a run at the very end', 'trailing fence\n```'],
  ['only backticks', '``````'],
  ['crlf line endings', 'one\r\n```\r\ntwo\r\n'],
]

describe('harness fencedOutput conforms to kernel fencedBlock', () => {
  for (const [name, input] of CORPUS) {
    it(`matches for ${name}`, () => {
      expect(fencedOutput(input)).toBe(fencedBlock(input))
    })
  }

  // The property the copy exists for, asserted directly so a conforming-but-wrong pair (both
  // drifting together) still fails: whatever the body contains, the block it produces opens and
  // closes on a run LONGER than anything inside it, so nothing in the body can terminate it.
  for (const [name, input] of CORPUS) {
    it(`produces a block the body cannot break out of, for ${name}`, () => {
      const block = fencedOutput(input)
      const fence = block.slice(0, block.indexOf('\n'))
      expect(fence.length).toBeGreaterThanOrEqual(3)
      expect(block.endsWith(`\n${fence}`)).toBe(true)
      // No run inside the body is long enough to close the fence.
      for (const match of input.matchAll(/`+/g)) {
        expect(match[0].length).toBeLessThan(fence.length)
      }
    })
  }
})
