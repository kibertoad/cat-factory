---
'@cat-factory/kernel': patch
---

Stop the URL-userinfo redaction rule from re-scanning a bounded run at every offset.

`redactSecrets` runs over every captured prompt, every LLM response body and every injected
context file before it lands in telemetry, so its cost is on the recording path for a whole
agent-context snapshot. One rule made that cost depend on the SHAPE of a body rather than its
size: the URL-userinfo pattern led with `[a-z][a-z0-9+.-]{0,39}`, and while that bound keeps the
rule linear (the comment on it records an earlier O(n²) fix), the engine still walked up to 40
characters at every position of any unbroken alphanumeric run before failing.

On prose that costs nothing, because words are short. On a long run of scheme-legal characters it
costs ~130ms per 512KB, roughly 15x prose, and base64 is not an exotic input here: an inlined
asset, a data URI, a lockfile hash column, a minified bundle attached as agent context all have
that shape.

The scheme moves into a lookbehind, so the pattern's first obligation at each offset is the
literal `://` and a non-matching position is rejected on a single character comparison. Cost is
now flat across shapes at ~8.5ms/MB. Redaction behaviour is unchanged: the scheme is no longer
consumed, so it survives in the output untouched rather than being re-emitted by the replacement,
and a differential run over the hand-written cases plus 200k randomised URL-alphabet strings found
no output difference.

Found via a unit test that scrubs ~6MB of single-character filler to exercise the snapshot size
budget. It spent 1.7s of its 5s default timeout inside this one rule, which is why it failed only
when the whole monorepo's suites ran concurrently; it is now 76ms. The shape-independence is
pinned by a comparison against prose of the same size rather than an absolute timing budget.
