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

  it('reads a LATER fence, not only the first', () => {
    expect(extractJson('```\nweighing it up\n```\nverdict:\n```json\n{"a":1}\n```')).toEqual({
      a: 1,
    })
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

  it('repairs raw control characters inside a string value', () => {
    // A reviewer asked for a multi-line summary writes the layout and forgets the `\n` escape.
    // The reply IS the verdict, so it is repaired rather than lost to a quoting slip.
    expect(
      extractJson('{"summary":"Verdict line.\n\n**Must fix**\n- a thing","rating":0.7}'),
    ).toEqual({ summary: 'Verdict line.\n\n**Must fix**\n- a thing', rating: 0.7 })
    expect(extractJson('{"a":"tab\there"}')).toEqual({ a: 'tab\there' })
  })

  it('prefers a strictly-parseable value over a repairable one, wherever each sits', () => {
    // THE regression the repair invites: a span that only parses once repaired must never
    // shadow one that parses as written, or an example shape / a prose aside becomes the
    // verdict. Both of these read as a clean 0.0 or a schema failure if the repair is tried
    // per candidate as the scan walks, instead of in a second pass over everything.
    expect(
      extractJson(
        'Example shape:\n```\n{"rating": 0.0, "summary": "one\nline"}\n```\n' +
          'Actual verdict:\n{"rating":0.9,"summary":"good"}',
      ),
    ).toEqual({ rating: 0.9, summary: 'good' })
    expect(
      extractJson('Notes on the field:\n{"name": "the field\nI mean"}\n\nVerdict:\n{"rating":0.4}'),
    ).toEqual({ rating: 0.4 })
    expect(extractJson('Consider ["the auth flow\nand tokens"] then {"rating":0.3}')).toEqual({
      rating: 0.3,
    })
  })

  it('keeps the fence preference when only a repair can read the reply', () => {
    // Nothing here parses as written, so the repair pass decides — and it walks the fences
    // before the whole reply, so the fenced verdict wins over the prose aside ahead of it.
    expect(
      extractJson(
        '```\nfirst I considered [the auth flow]\n```\nNotes: {"note":"see\nbelow"}\n' +
          '```json\n{"rating":0.9,"summary":"multi\nline"}\n```',
      ),
    ).toEqual({ rating: 0.9, summary: 'multi\nline' })
  })

  it('leaves structural whitespace and already-escaped text alone while repairing', () => {
    // The newline between the two members is structure, not content: repairing must not
    // smuggle it into a value. The escaped `\n` in the first value stays one escape, not two.
    expect(extractJson('{\n  "a": "line\\nbreak",\n  "b": "raw\nbreak"\n}')).toEqual({
      a: 'line\nbreak',
      b: 'raw\nbreak',
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
