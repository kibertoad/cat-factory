import { extractJson } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { extractJsonObject } from '../src/json-reply.js'

// `src/json-reply.ts` reads an agent's structured reply in the container; kernel's `extractJson`
// reads the SAME reply again in the engine. The harness reads it first, and every reply it refuses
// costs a billed repair completion before the engine's read ever happens — so the property that
// matters is that the two agree about which replies are READABLE, and the malformation the review
// layout invites (a multi-line summary written with raw line breaks) is top of that list.
//
// WHICH object each half returns is deliberately not pinned: kernel scans forward from every
// bracket and may answer with an array, while this half takes the outermost `{…}` span because its
// caller declared a single object. The corpus below is therefore the single-object replies where
// they must land on the same value.

const VERDICT = { rating: 0.7, summary: 'Verdict line.\n\n**Must fix**\n- a thing' }

const CORPUS: Array<[name: string, reply: string]> = [
  ['a bare object', '{"rating":0.7,"summary":"fine"}'],
  ['a fenced object', '```json\n{"rating":0.7,"summary":"fine"}\n```'],
  ['an untagged fenced object', '```\n{"rating":0.7,"summary":"fine"}\n```'],
  ['an object wrapped in prose', 'Here is my verdict:\n{"rating":0.7,"summary":"fine"}\nThanks!'],
  [
    'raw line breaks inside the summary (the review layout)',
    `{"rating":0.7,"summary":"Verdict line.\n\n**Must fix**\n- a thing"}`,
  ],
  ['a raw tab inside a value', '{"rating":0.7,"summary":"tab\there"}'],
  ['an unbalanced brace inside a string value', '{"summary":"it closes the } here","rating":0.7}'],
  ['a pretty-printed object', '{\n  "rating": 0.7,\n  "summary": "fine"\n}'],
]

describe('harness json-reply conforms to kernel extractJson on readability', () => {
  for (const [name, reply] of CORPUS) {
    it(`reads ${name} the same way kernel does`, () => {
      expect(extractJsonObject(reply)).toEqual(extractJson(reply))
    })
  }

  it('reads a multi-line summary written with raw line breaks, with no repair call', () => {
    // The whole point: this reply used to throw here, and a throw is what `resolveStructuredOutput`
    // spends a model call on.
    expect(
      extractJsonObject(`{"rating":0.7,"summary":"Verdict line.\n\n**Must fix**\n- a thing"}`),
    ).toEqual(VERDICT)
  })

  it('leaves structural whitespace and already-escaped text alone while repairing', () => {
    expect(extractJsonObject('{\n  "a": "line\\nbreak",\n  "b": "raw\nbreak"\n}')).toEqual({
      a: 'line\nbreak',
      b: 'raw\nbreak',
    })
  })

  it('still refuses a reply with no readable object, as its caller depends on', () => {
    // `resolveStructuredOutput` treats the throw as "no value" and only THEN pays for a repair.
    for (const reply of ['', 'no json here at all', '{"a":1', '{not: valid json}']) {
      expect(() => extractJsonObject(reply)).toThrow(/did not return a JSON object/)
      expect(extractJson(reply)).toBeNull()
    }
  })
})
