import { describe, expect, it } from 'vitest'
import {
  DataIntegrityError,
  dataIntegrityFaultOf,
  isDataIntegrityError,
  isDataIntegrityFault,
} from './data-integrity.js'

// Recognising an integrity error, and how much of it a recogniser may promise.
//
// Both halves are load-bearing for the ENGINE, not just for logging. A run row that cannot be
// decoded is DISPOSED of (written terminal) rather than re-driven forever, so a false negative
// resurrects an immortal run and a false positive on the FAULT destroys a live one.

describe('isDataIntegrityError', () => {
  it('recognises the class', () => {
    expect(isDataIntegrityError(new DataIntegrityError('x', {}, 'malformed'))).toBe(true)
  })

  it('recognises an instance from another COPY of this package', () => {
    // A facade can end up with two copies of kernel in its tree, and `instanceof` across copies is
    // false while the class is the same class. That is the whole reason this is a predicate and not
    // an `instanceof` at each call site.
    const foreign = new Error('Execution row has no block_id')
    foreign.name = 'DataIntegrityError'
    expect(isDataIntegrityError(foreign)).toBe(true)
  })

  it('rejects an ordinary throw, so a database blip is never mistaken for corruption', () => {
    expect(isDataIntegrityError(new Error('connection terminated unexpectedly'))).toBe(false)
    expect(isDataIntegrityError(new TypeError('x'))).toBe(false)
    expect(isDataIntegrityError('DataIntegrityError')).toBe(false)
    expect(isDataIntegrityError(null)).toBe(false)
  })
})

describe('dataIntegrityFaultOf', () => {
  it('reports the fault the thrower stated', () => {
    expect(dataIntegrityFaultOf(new DataIntegrityError('x', {}, 'malformed'))).toBe('malformed')
    expect(dataIntegrityFaultOf(new DataIntegrityError('x', {}, 'unrecognized_value'))).toBe(
      'unrecognized_value',
    )
  })

  it('falls back to the REVERSIBLE fault when none survived', () => {
    // An error rebuilt across a boundary that dropped the fault (an older mothership peer), or one
    // recognised only by name, knows less than the thrower did. Answering `malformed` there would
    // let that uncertainty settle a healthy run terminally; `unrecognized_value` costs a re-drive.
    const foreign = new Error('Execution row has no block_id')
    foreign.name = 'DataIntegrityError'
    expect(dataIntegrityFaultOf(foreign)).toBe('unrecognized_value')
    expect(dataIntegrityFaultOf({ ...new Error('x'), fault: 'not_a_member' } as never)).toBe(
      'unrecognized_value',
    )
  })
})

describe('isDataIntegrityFault', () => {
  it('accepts every member and nothing else', () => {
    expect(isDataIntegrityFault('malformed')).toBe(true)
    expect(isDataIntegrityFault('unrecognized_value')).toBe(true)
    expect(isDataIntegrityFault('MALFORMED')).toBe(false)
    expect(isDataIntegrityFault(undefined)).toBe(false)
  })
})
