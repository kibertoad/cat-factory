---
'@cat-factory/kernel': patch
---

Make `redactSecrets` cost depend on the SIZE of a body rather than its shape.

The scrub runs over every captured prompt, every LLM response body and every injected context
file before it lands in telemetry, so its cost is on the recording path for a whole
agent-context snapshot. Two rules made that cost depend on the shape of a body instead, and
neither is visible in an absolute timing budget: both are cheap on prose and expensive on
inputs that are entirely ordinary in agent context.

**URL userinfo.** The pattern led with `[a-z][a-z0-9+.-]{0,39}` before the required `://`. That
bound keeps the rule linear (the comment on it records an earlier O(n²) fix, and that fix was
right), but a bounded run in the LEADING position is still re-walked at every offset: ~40 steps
per character of any unbroken alphanumeric text before failing. That is ~130ms per 512KB of
base64, roughly 15x prose, and base64 is not an exotic input here (an inlined asset, a data URI,
a lockfile hash column, a minified bundle). The scheme moves into a lookbehind, so the pattern's
first obligation at each offset is the literal `://` and a non-matching position is rejected on
a single character comparison.

**PEM private-key blocks.** The rule was one regex spanning `BEGIN … [\s\S]*? … END`. That body
is unbounded, so a header with no END after it makes the engine scan to end-of-string, advance
to the next header, and rescan the same tail: quadratic in the number of unterminated headers,
not merely a bad constant. 2MB of them took ~19 SECONDS. Truncation upstream of the scrub
produces exactly that input, since a capped context file can lose its END marker. The two
markers are now walked in lockstep by `redactPrivateKeyBlocks`, where each scan only moves
forward and a header with no END ends the whole pass (no later header can have one either),
making it strictly O(n).

Redaction behaviour is unchanged on both counts, verified differentially rather than by
inspection. For the URL rule the scheme is no longer consumed, so it survives in the output
untouched instead of being re-emitted by the replacement; the hand-written cases plus 200k
randomised URL-alphabet strings produce byte-identical output. For the PEM rule the pairing
decisions a scanner could plausibly get wrong (first END wins, a nested header is swallowed, an
unterminated header is left in place, scanning resumes after the closing marker) are pinned as
explicit cases, and 300k randomised marker-dense strings produce byte-identical output.

Credential-free bodies now cost within ~1.15x of prose of the same size whatever their shape,
against ~10x for base64 and ~1000x for unterminated PEM headers before. That is a statement
about the rules as they stand rather than a property anything enforces: the test measures each
known-pathological shape against prose instead of an absolute budget, so it survives a slow CI
box, but a new rule with the same defect needs its own shape added there to be caught. A body
full of real credentials is legitimately slower (~10x on back-to-back URLs), because that cost
is redaction work rather than rescanning.

Found via a unit test that scrubs ~6MB of single-character filler to exercise the snapshot size
budget. It spent 1.7s of its 5s default timeout inside the URL rule, which is why it failed only
when the whole monorepo's suites ran concurrently; it is now 76ms.
