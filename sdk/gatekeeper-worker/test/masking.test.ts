import { describe, expect, it } from 'vitest'
import { applyMask, MASKED } from '../src/masking.js'

describe('applyMask', () => {
  it('replaces a masked leaf rather than removing it', () => {
    const masked = applyMask(
      { run: { id: 'exec_9', pullRequestUrl: 'https://example.com/pull/1' } },
      ['run.pullRequestUrl'],
    )
    expect(masked).toEqual({ run: { id: 'exec_9', pullRequestUrl: MASKED } })
  })

  // A removed key and a key the platform had no value for read identically to the agent consuming
  // the result, and they are different facts.
  it('is distinguishable from a null the platform sent', () => {
    const masked = applyMask({ a: null, b: 'x' }, ['b']) as Record<string, unknown>
    expect(masked.a).toBeNull()
    expect(masked.b).toBe(MASKED)
  })

  it('traverses arrays element-wise', () => {
    const masked = applyMask({ steps: [{ status: 'done' }, { status: 'running' }] }, [
      'steps.status',
    ])
    expect(masked).toEqual({ steps: [{ status: MASKED }, { status: MASKED }] })
  })

  // A result shape legitimately varies by operation, so a policy naming a field some responses do
  // not carry is not a misconfiguration and must not invent one.
  it('leaves a path that matches nothing alone', () => {
    expect(applyMask({ a: 1 }, ['b.c'])).toEqual({ a: 1 })
    expect(applyMask(null, ['a'])).toBeNull()
    expect(applyMask('scalar', ['a'])).toBe('scalar')
  })

  // The same decoded body reaches more than one consumer, so a mask applied in place would
  // silently redact a caller nobody asked to mask.
  it('does not mutate its input', () => {
    const original = { run: { url: 'https://example.com' } }
    applyMask(original, ['run.url'])
    expect(original.run.url).toBe('https://example.com')
  })

  it('applies every path, and an empty list is the identity', () => {
    expect(applyMask({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: MASKED, b: 2, c: MASKED })
    expect(applyMask({ a: 1 }, [])).toEqual({ a: 1 })
    expect(applyMask({ a: 1 }, [''])).toEqual({ a: 1 })
  })
})
