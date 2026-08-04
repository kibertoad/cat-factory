import { describe, expect, it } from 'vitest'
import { parseTraceparent } from './trace-context.js'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN = '00f067aa0ba902b7'

describe('parseTraceparent', () => {
  it('reads a well-formed header, carrying the caller’s sampling decision', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      sampled: true,
    })
    // Every other bit of the flags byte is reserved; only the low one is `sampled`.
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)?.sampled).toBe(false)
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-fe`)?.sampled).toBe(false)
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-ff`)?.sampled).toBe(true)
  })

  it('accepts an UNKNOWN future version, per the spec’s forward-compatibility rule', () => {
    // A caller on a later spec version still puts these four fields at the front, so dropping
    // its header would un-join a trace over a version byte we have no opinion about.
    expect(parseTraceparent(`cc-${TRACE}-${SPAN}-01`)?.traceId).toBe(TRACE)
  })

  it('refuses the RESERVED version and both all-zero ids', () => {
    expect(parseTraceparent(`ff-${TRACE}-${SPAN}-01`)).toBeNull()
    // The spec's own "invalid" sentinels. A broken upstream instrumentation emits them, and
    // adopting one would file every such request into a single enormous shared trace.
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE}-${'0'.repeat(16)}-01`)).toBeNull()
  })

  it('refuses anything that is not the exact grammar', () => {
    // The header is untrusted and its value is echoed into every exported line for the
    // request, so the parse admits only the fixed-width hex shape — which is also what makes
    // it safe to echo with no downstream sanitising.
    for (const bad of [
      undefined,
      null,
      '',
      '   ',
      TRACE,
      `00-${TRACE}-${SPAN}`,
      `00-${TRACE}-${SPAN}-01-extra`,
      `00-${TRACE.slice(0, 31)}-${SPAN}-01`,
      `00-${TRACE}-${SPAN}g-01`,
      `00 ${TRACE} ${SPAN} 01`,
      `00-${TRACE}-${SPAN}-01\n<script>`,
    ]) {
      expect(parseTraceparent(bad), String(bad)).toBeNull()
    }
  })

  it('normalises surrounding whitespace and upper-case hex', () => {
    // Header values arrive with incidental whitespace, and hex is case-insensitive by nature
    // even though the spec emits lower — refusing an upper-case id would be pedantry that
    // costs a real caller their trace.
    expect(parseTraceparent(`  00-${TRACE.toUpperCase()}-${SPAN.toUpperCase()}-01 `)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      sampled: true,
    })
  })
})
