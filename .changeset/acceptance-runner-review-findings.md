---
'@cat-factory/acceptance': patch
---

Review findings on the standalone acceptance runner (#1983).

The one with a behaviour change worth naming: the up-front personal-password ask filled the unlock
holder eagerly, so `X-Personal-Password` rode every request of the pass rather than starting at the
first `428` as it did before the runner conversion (where the injected value was installed as a lazily
consulted supplier). Asking early is a fact about the operator being at the terminal; it may not also
decide where the secret goes. `PersonalUnlock.prime` collects without holding, so the fourteen preflight
probes, the repository and service reads and the decision polls travel without a credential they have no
use for, and the operator is still asked exactly once.

The rest are the pass's own reporting. Every command now prints to stdout, refusals included, because a
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

Docs: the claim that a `.ts` entry point "does not load at all" below Node 24 was false (type stripping
is on by default from 22.18 and 23.6, as CONTRIBUTING.md already said), so a successful run was never
evidence of the floor.
