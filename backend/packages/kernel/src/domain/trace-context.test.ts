import { describe, expect, it } from 'vitest'
import { parseTraceparent } from './trace-context.js'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN = '00f067aa0ba902b7'

describe('parseTraceparent', () => {
  it('reads the two ids a log line can act on, and only those', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
    })
    // The flags byte is part of the GRAMMAR and is validated as such, but its `sampled` bit is
    // deliberately not carried: this deployment has no sampler, so an exported record's flags
    // state its own export decision rather than the caller's. Every flags value that parses
    // yields the same two ids, which is the whole point.
    for (const flags of ['00', '01', 'fe', 'fd']) {
      expect(parseTraceparent(`00-${TRACE}-${SPAN}-${flags}`)).toEqual({
        traceId: TRACE,
        spanId: SPAN,
      })
    }
  })

  it('accepts an UNKNOWN future version, per the spec’s forward-compatibility rule', () => {
    // A caller on a later spec version still puts these four fields at the front, so dropping
    // its header would un-join a trace over a version byte we have no opinion about.
    expect(parseTraceparent(`cc-${TRACE}-${SPAN}-01`)?.traceId).toBe(TRACE)
    // And that rule has teeth only if a future version may APPEND: the spec says a parser reads
    // the fields it understands and ignores the rest. Anchoring the pattern without this would
    // have made "forward-compatible" true of the version byte and false of everything it exists
    // to allow.
    expect(parseTraceparent(`cc-${TRACE}-${SPAN}-01-a1b2`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
    })
  })

  it('holds version 00 to EXACTLY the four fields it is fixed at', () => {
    // The other half of forward-compatibility: `00` is specified as 55 characters, so trailing
    // data is a malformed `00` header, not a newer one. Accepting it would let anything ride
    // along under the version every real caller actually sends.
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01-extra`)).toBeNull()
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
    // request, so the parse admits only the fixed-width hex shape, which is also what makes
    // it safe to echo with no downstream sanitising.
    for (const bad of [
      undefined,
      null,
      '',
      '   ',
      TRACE,
      `00-${TRACE}-${SPAN}`,
      `00-${TRACE.slice(0, 31)}-${SPAN}-01`,
      `00-${TRACE}-${SPAN}g-01`,
      `00 ${TRACE} ${SPAN} 01`,
      `00-${TRACE}-${SPAN}-01\n<script>`,
      // Trailing data that is not itself hex is malformed under ANY version.
      `cc-${TRACE}-${SPAN}-01-<script>`,
    ]) {
      expect(parseTraceparent(bad), String(bad)).toBeNull()
    }
  })

  it('refuses an oversized header before doing any work on it', () => {
    // Bounded FIRST, so a hostile megabyte header is not lower-cased and scanned on a path that
    // runs for every request. The pattern would reject it either way; this makes the cost
    // proportional to what a real caller sends.
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01${'-a'.repeat(400)}`)).toBeNull()
  })

  it('normalises surrounding whitespace and upper-case hex', () => {
    // Header values arrive with incidental whitespace, and hex is case-insensitive by nature
    // even though the spec emits lower. Refusing an upper-case id would be pedantry that costs
    // a real caller their trace.
    expect(parseTraceparent(`  00-${TRACE.toUpperCase()}-${SPAN.toUpperCase()}-01 `)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
    })
  })
})
