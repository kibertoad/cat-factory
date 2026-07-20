import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from './registry.js'
import { CODE_AWARE_TRAIT, DOC_AWARE_TRAIT, hasTrait, traitsFor } from './traits.js'
import { BLUEPRINTS_AGENT_KIND, SPEC_WRITER_AGENT_KIND } from './spec-blueprints.js'
import { ENVIRONMENT_ANALYST_KIND } from './environment-analyst.js'

// Only `code-aware` and `doc-aware` actually FOLD the task's selected fragments into the agent's
// system prompt (`AgentContextBuilder.resolveFragments` gates on exactly those two: technical
// best-practice fragments for code-aware, writing-style fragments for doc-aware). `spec-aware` does
// NOT fold anything — it only appends the static spec-reading guidance. So a registered repo-cloning
// kind that should receive the task's fragments must carry one of THESE two; carrying only
// `spec-aware` (or no trait at all) silently drops the selection and records 0 in the "Provided
// context" snapshot — the `pr-reviewer` bug this guard exists to prevent from recurring.
//
// The guard therefore enforces the FOLD, not merely "some context trait": a kind that clones a repo
// either folds fragments (code-aware/doc-aware) or is on the explicit, justified opt-out list below.
//
// Scoped to REGISTERED kinds (the `registerAgentKind` extension seam — where new kinds, incl.
// deployment-authored ones, are added). Built-in non-registered kinds get their traits from
// `STANDARD_AGENT_TRAITS`; the spec-aware-only built-ins there (merger, testers, mocker, …) are
// out of this guard's scope by design and are not repo-cloning extension kinds.
const FRAGMENT_FOLD_TRAITS = [CODE_AWARE_TRAIT, DOC_AWARE_TRAIT]

// Registered kinds that clone a repo but INTENTIONALLY fold no fragments, each with its reason.
// Adding a kind here must be a deliberate, reviewed choice — not a way to silence the guard.
const FRAGMENT_FOLD_OPT_OUT = new Set<string>([
  // Authors the spec from scratch: it consumes neither best-practice fragments nor the in-repo
  // spec (it IS the spec's author), so it is deliberately absent from every trait source.
  SPEC_WRITER_AGENT_KIND,
  // Reads the repo only to draft a Docker / runtime recipe; coding best-practice fragments and
  // the in-repo spec are not relevant to that output.
  ENVIRONMENT_ANALYST_KIND,
  // Produces the structural service → modules decomposition (spec-aware only). It maps the repo's
  // shape rather than applying coding standards, so the task's best-practice fragments are not
  // relevant to its output — it deliberately folds none.
  BLUEPRINTS_AGENT_KIND,
])

describe('registered container kinds fold the task fragments', () => {
  const registry = defaultAgentKindRegistry()
  for (const def of registry.all()) {
    if (!registry.requiresContainer(def.kind)) continue
    it(`${def.kind} carries a fragment-folding trait (or is a documented opt-out)`, () => {
      if (FRAGMENT_FOLD_OPT_OUT.has(def.kind)) return
      const traits = traitsFor(def.kind, registry)
      const folds = FRAGMENT_FOLD_TRAITS.some((t) => traits.has(t))
      expect(
        folds,
        `${def.kind} clones a repo but carries no fragment-folding trait (code-aware/doc-aware). ` +
          `The task's selected best-practice / writing-style fragments will be silently dropped and ` +
          `recorded as 0 in the "Provided context" snapshot. Add code-aware (or doc-aware) so its ` +
          `context is folded, or add it to FRAGMENT_FOLD_OPT_OUT with a justification.`,
      ).toBe(true)
    })
  }
})

// Pins the exact fold trait for every kind touched by the fragment-fold fix, so a later edit that
// drops the trait — or swaps it for a non-folding one like spec-aware — fails here by name rather
// than only through the collective guard above. `conflict-resolver` is a built-in
// (STANDARD_AGENT_TRAITS) not covered by the registered-kind guard, so its regression lives here too.
describe('repo-reading kinds are code-aware (fragment-fold regression)', () => {
  const registry = defaultAgentKindRegistry()
  const CODE_AWARE_KINDS = [
    'pr-reviewer',
    'bug-investigator',
    'fork-proposer',
    'initiative-analyst',
    'initiative-planner',
    'spike',
    'ralph',
    'repro-test',
    'skill',
    'conflict-resolver',
  ] as const
  for (const kind of CODE_AWARE_KINDS) {
    it(`${kind} carries code-aware`, () => {
      expect(hasTrait(kind, CODE_AWARE_TRAIT, registry)).toBe(true)
    })
  }
})
