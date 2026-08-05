---
'@cat-factory/app': patch
---

E2E coverage for the four flows a human actually meets first

The browser suite covered a lot of the engine and almost none of the everyday loop. Four essentials
had no assembled-product coverage at all, and three of them were unreachable rather than merely
unwritten: the mocks did not exist.

- **The pre-dispatch input gate**, the first thing every run does. No spec reached it because every
  REST-seeded fixture task carries a description precisely so it doesn't park. Both exits are now
  driven, since a gate whose only exit is "ignore me" cannot be satisfied.
- **Requirements review**, the first step of the default pipelines and the main human-in-the-loop
  surface. Its whole loop is three INLINE LLM calls, which the fake agent executor never sees, so
  the keyless backend could not run it.
- **Judges**, the fourth step-taxonomy bucket. Two things were missing: the registry ships EMPTY, and
  an unwired assessor makes every judge step a pass-through.
- **Starting and stopping a run by hand.** Every other spec starts runs over REST, which left the two
  controls a human actually presses uncovered.

The inline-LLM mock is the interesting one. An inline call carries nothing that says which step of a
flow it belongs to, so the fake answers by the SHAPE OF ITS PROMPT, with markers quoted from the
engine's own prompt builders. That copy can rot, and it rots in the worst direction: an unmatched
prompt falls through to the interview reply, whose JSON carries no `items`, so a drifted marker turns
the requirements reviewer into one that finds nothing and auto-passes — a failure that reads as an
engine bug. So the browser-free lane classifies prompts built by the REAL builders
(`requirementsLogic`), not by hand-written strings that would only pin the fake to itself. WHAT it
answers is per-workspace, resolved from the same profile registry the agent and gate fakes read, so
an unscripted workspace keeps the historical behaviour and every pre-existing spec is byte-identical.

The judge seam registers the SHIPPED example (`@cat-factory/example-custom-agent`'s
`scope-adherence`, including its own valibot verdict parser) through the same public seam a
deployment uses, rather than a test-only lookalike — so the suite now covers the reference
implementation the docs point deployments at, and the fact that no frontend code names the kind: it
arrives through the workspace capability manifest with `resultView: 'judge'`.

The only product change is test hooks: `data-testid`s on the board card's Start button, the
input-gate finding rows (with the finding CODE as an attribute, so a spec asserts which input was
named rather than that some box appeared), the requirements-review window's findings / answer box /
rail actions, the add-task modal's description field, the inspector's step-open button, and the judge
window's round-history rows (carrying each round's DISPOSITION, so a bounce is asserted on the
engine's own record of it rather than inferred from the run having finished).
