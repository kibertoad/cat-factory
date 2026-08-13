---
'@cat-factory/acceptance': patch
---

Review findings on the standalone acceptance runner (#1983).

These are the pass's own reporting, plus one documented decision about the personal-password ask. Every command now prints to stdout, refusals included, because a
`tee`d afternoon-long pass captures one stream and the configuration refusal, the declined prompt and
the suite-failure report were on the other. A `ScenarioFailure` carries its message and its location
separately, so a suite bug's stack frames stop being folded into the one-line phase message `status`
renders. The three startup boundaries pick their describer off a new `OperatorRefusal` marker rather than
off which boundary they are, so a `TypeError` before the pass opens is no longer printed as a
one-sentence refusal with no file and no line. The suite-failure exit gates its `resume:` line on the
ledger the way the closing words already did. The preflight report scenario carries every red
prerequisite's remedy instead of the first one's, which is rule 4 and what the terser gate behind it
already did. And `status`'s no-argument default is back to "the pass that ran last": an
`ACCEPTANCE_RUN_ID` line in the `.env` names the pass to report on, but a `latest` in that file no longer
converts the bare form into the pointer question, which refuses where the bare form would have answered.

The personal-password ask keeps HOLDING what it collects, and that is now argued for rather than
incidental: the suite exists to be run headless, so an operator starts a pass and walks away, and once
the pinned preset has confirmed the pass will spend their subscription there is nothing to gain by
withholding the answer until a call is refused. Collecting-without-holding would narrow the exposure to
a few reads against the one deployment the pass is pinned to (which consults the header only on the
gated run calls) and would make "the pass has the credential" a rule each future call site remembers
through `withPersonalUnlock` rather than a property of the client seam.

Docs: the claim that a `.ts` entry point "does not load at all" below Node 24 was false (type stripping
is on by default from 22.18 and 23.6, as CONTRIBUTING.md already said), so a successful run was never
evidence of the floor.
