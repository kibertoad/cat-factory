import { describe, expect, it } from 'vitest'
import { extractJson } from './llm-output.js'

// Every structured verdict the platform reads off a model (a judge's scores, a merger's
// assessment, an on-call culprit) arrives inside prose the model felt like writing. What is
// pinned here is the recovery: which shapes are found, and which are refused as "no JSON" rather
// than being half-parsed into a verdict nobody wrote.

describe('extractJson', () => {
  it('reads a bare object or array reply', () => {
    expect(extractJson('{"ok":true}')).toEqual({ ok: true })
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3])
    expect(extractJson('   \n {"ok":true}\n  ')).toEqual({ ok: true })
  })

  it('reads it out of the surrounding prose', () => {
    expect(extractJson('Here is my verdict:\n{"score":0.7}\nHope that helps!')).toEqual({
      score: 0.7,
    })
  })

  it('prefers a fenced block, with or without the language tag', () => {
    expect(extractJson('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('```JSON\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('falls back to the whole reply when the first fence holds no JSON', () => {
    // A model that fences its REASONING before emitting the real object: reading only the first
    // fence would report the run as having produced nothing.
    expect(extractJson('```\nfirst I considered the auth flow\n```\n{"a":1}')).toEqual({ a: 1 })
  })

  it('skips a bracket in the prose and finds the real value after it', () => {
    expect(extractJson('I weighed [the auth flow] and concluded: {"verdict":"pass"}')).toEqual({
      verdict: 'pass',
    })
  })

  it('is not fooled by a bracket inside a string value', () => {
    // The matcher is string-literal aware, so an unbalanced brace inside a rationale does not
    // truncate the object into a parse failure.
    expect(extractJson('{"rationale":"it closes the } here","ok":true}')).toEqual({
      rationale: 'it closes the } here',
      ok: true,
    })
    expect(extractJson('{"rationale":"an escaped quote \\" and a brace {","ok":true}')).toEqual({
      rationale: 'an escaped quote " and a brace {',
      ok: true,
    })
  })

  it('returns the FIRST value that parses, nesting included', () => {
    expect(extractJson('{"outer":{"inner":1}} then {"second":2}')).toEqual({
      outer: { inner: 1 },
    })
  })

  it('reports no JSON rather than half of one', () => {
    expect(extractJson('')).toBeNull()
    expect(extractJson('no json here at all')).toBeNull()
    // An unterminated object never closes, so there is nothing to hand a caller.
    expect(extractJson('{"a":1')).toBeNull()
    expect(extractJson('{not: valid json}')).toBeNull()
  })
})
