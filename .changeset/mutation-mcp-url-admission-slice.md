---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': patch
---

Rule MCP tool-server URLs on the host the request actually reaches, and give the gate, generator and service-frame seams their first tests

Taken from the nightly's per-file undetected counts rather than its headline score, which is what
separates the two dispositions: a file whose count is nearly all `NoCoverage` wants a test, a high
`Survived` count on a tested module wants assertions. Several kernel files were the first kind, and
writing the tests for one of them turned up a live hole.

**The hole.** `isAllowedMcpHttpUrl` decides whether a resolved credential may ride a CLEARTEXT
request header, and it read the host with a hand-written authority scan that stopped at `/`, `?`
and `#`. A backslash also terminates the authority of a special scheme, so
`http://evil.example\@127.0.0.1/mcp` parses to host `evil.example` for `fetch` and every agent CLI,
while the scan swallowed the delimiter, found a last `@` that was no userinfo separator, read
`127.0.0.1`, and granted the cleartext exemption. It is reachable from outside: `readEndpoints`
takes `token_endpoint` verbatim out of a third party's OAuth metadata document and
`assertAllowedOAuthUrl` is the only thing standing in front of the POST that carries the
`client_secret`.

The fix is not the missing delimiter. A hand-written parse cannot hold the property this predicate
exists for (the host ruled on is the host the credential travels to), and the ways it loses that
property are not enumerable: the backslash is one member of the class, and the same scan also read
`0177.0.0.1`, `127.1` and `2130706433` as non-loopback when they all dial `127.0.0.1`. That had
the operability probe pointing at the BACKEND's own loopback instead of refusing by name. So the
parse is now the WHATWG parser itself, the one the request is resolved with. Kernel compiles
against the ES2022 lib, so it is reached through `globalThis` behind a minimal local type, the same
trade `ports/binary-artifacts.ts` makes for Web Crypto; a runtime without it refuses rather than
falling back, since the fallback is the bug.

Narrower in one place, deliberately: a url carrying an ASCII control character or a space is now
refused outright rather than canonicalised. The parser trims and strips those, so such a url reads
as one thing and parses as another, and the admitted string is stored and written VERBATIM into the
agent CLI's MCP config.

The harness carries a byte-for-byte copy of the rule (the image builds from `src/` plus typescript
and can depend on no workspace package) and had drifted textually already. Its conformity suite
compares behaviour over a corpus, which cannot catch a spoof neither side thought of, so it now also
derives the expectation from the authority: whatever else the rule does, a cleartext url it admits
must resolve to a host that really is loopback.

**The tests.** `GateRegistry` itself was untested (only `recordGateAttempt` beside it was) and
`BinaryGeneratorRegistry` had no test file at all; the gap that mattered in both is
override-replaces-rather-than-accumulates, since overriding a built-in is the whole point of the
seam. With those two, every app-owned registry seam in `domain/` has a test sibling, which the
mutation doc had already claimed and is now true. `resolveServiceFrameBlock` is the ancestry walk
every prompt-assembling path resolves "which service is this?" through, and its contract is easy to
get subtly wrong: on a chain with no frame in it, it returns the TOPMOST block rather than null, and
`describeOwnService` re-checks the level to turn that into the stated refusal. A walk that returned
null instead would swap one refusal for another that reads identically. The UTF-8 width boundaries
in `toolServerDeclaredBytes` are pinned at each of the three comparisons rather than through one
CJK sample.

Spend's three real survivors are closed too: a window that has only just opened with nothing in it
is the confident zero again (the short-history rule is guarded on there being a first ROW, not on a
short span), a LATER tier raising the merged alert threshold, and the service carrying the window's
own cost and first-seen stamp into the forecast rather than the fallbacks beside them. Its
remaining survivors are equivalent mutants and are left alone: `Number.isFinite` already refuses
what the `!= null` beside it refuses in `budgetCapsOverlay`, and in `exhaustionAt` an infinite limit
divides to `Infinity` and a zero rate to the same, so both comparisons answer identically. A
`Stryker disable` for either would hide a survivor rather than explain one.
