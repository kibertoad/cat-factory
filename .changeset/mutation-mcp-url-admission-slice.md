---
'@cat-factory/kernel': patch
---

Give kernel's MCP URL admission, gate registry and service-frame walk their first tests, and close spend's remaining real survivors

Taken from the nightly's per-file undetected counts rather than its headline score, which is what
separates the two dispositions: a file whose count is nearly all `NoCoverage` wants a test, a high
`Survived` count on a tested module wants assertions. Three kernel files were the first kind.

The one worth naming is `agent-capabilities`' HTTP tool-server admission. `isAllowedMcpHttpUrl`
decides whether a resolved credential may ride a cleartext request header, and neither it nor the
hand-written parse under it had a single test: 61 `NoCoverage` mutants over a security boundary.
The parse is hand-written precisely so userinfo can be stripped from the LAST `@`, so that is what
the new tests state, beside the rest of what the salvage must never do: read a path, query or
fragment as the host, accept an unterminated IPv6 bracket by slicing a loopback address out of it,
or match `127.0.0.0/8` unanchored at either end. Every one of those turns a non-loopback host into
one that earns the cleartext exemption. The UTF-8 width boundaries in `toolServerDeclaredBytes` are
pinned the same way, at each of the three comparisons rather than through one CJK sample.

The other two are structural. `GateRegistry` itself was untested (only `recordGateAttempt` beside
it was), which makes the doc's claim that the app-owned registry seams all score 100% wrong; the
gap that mattered is override-replaces-rather-than-accumulates, since a deployment overriding a
built-in gate is the whole point of the seam. `resolveServiceFrameBlock` is the ancestry walk every
prompt-assembling path resolves "which service is this?" through, and its contract is easy to get
subtly wrong: on a chain with no frame in it, it returns the TOPMOST block rather than null, and
`describeOwnService` re-checks the level to turn that into the stated refusal. A walk that returned
null instead would swap one refusal for another that reads identically.

One mutant was unkillable rather than unasserted: `hostPort.split(':')[0] ?? ''` cannot take its
fallback, because `String.split` always returns at least one element. Deleted rather than asserted
around, which also removes it from the denominator.

Spend's three real survivors are closed too: a window that has only just opened with nothing in it
is the confident zero again (the short-history rule is guarded on there being a first ROW, not on a
short span), a LATER tier raising the merged alert threshold, and the service carrying the window's
own cost and first-seen stamp into the forecast rather than the fallbacks beside them. Its
remaining survivors are equivalent mutants and are left alone: `Number.isFinite` already refuses
what the `!= null` beside it refuses in `budgetCapsOverlay`, and in `exhaustionAt` an infinite limit
divides to `Infinity` and a zero rate to the same, so both comparisons answer identically. A
`Stryker disable` for either would hide a survivor rather than explain one.
