# `@cat-factory/sandbox-fixtures`: graded no-repo fixtures for the sandbox

Hand-authored inline agent inputs + expectations, rated by trickiness and impact. Consumed by
`@cat-factory/sandbox`. Six families: requirements review, bug-report (clarity) triage, recommended
answers (the Requirement Writer), task estimation, code review, and architecture-proposal review.

**Entry:** `src/index.ts`; the fixtures live under `src/fixtures/`.

**A payload is the EXACT context shape the agent's production caller consumes**, because the
run-driver renders it through that caller's own pure prompt builder
(`orchestration/modules/sandbox/sandbox-input.ts`), not an approximation. So a payload that has
drifted no longer just renders thinner, it renders differently; `sandbox-fixture-payloads.test.ts`
(in orchestration, which can see both) pins each family against the real types.

**A repo-SCALE change goes on `injectedContextFiles`** (`code-review-repo.ts`), which is the
production seam for delivering repository material to a caller with no filesystem, and is what makes
the multi-file findings (the ones invisible in any single file) reachable at all. There are
deliberately NO builtin `repo-feature` / `repo-bug` fixtures: those need a `repoRef` naming a
repository, which no deployment-neutral builtin can supply. Why an injected FAKE repository is not
the answer either:
[`sandbox-coverage-expansion.md`](../../../docs/initiatives/sandbox-coverage-expansion.md).

Authoring rules the registry test enforces, each because a fixture that breaks it grades but
discriminates nothing:

- **Every expectation needs explicit `matchHints`**, and a hint whose word form varies needs a
  trailing `*` (`idempoten*`). Matching is whole-token, so a bare stem or a full sentence is a dead
  hint scored "missed" for every answer.
- **Every fixture needs one impact ≥ 4 and one trickiness ≥ 4.** `impactRecall` needs something whose
  miss actually hurts; `wowBonus` divides by the tricky total, so a fixture with nothing tricky is a
  constant 1 and ranks a thorough answer level with a shallow one.
- **Two fixtures per agent, spanning simple to complex.** An all-hard set cannot tell a weak model
  from a broken one; an all-easy set cannot rank.
