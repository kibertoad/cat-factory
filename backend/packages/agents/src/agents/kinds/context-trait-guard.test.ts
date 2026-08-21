import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from './registry.js'
import { CODE_AWARE_TRAIT, DOC_AWARE_TRAIT, hasTrait, traitsFor } from './traits.js'
import { BLUEPRINTS_AGENT_KIND, SPEC_WRITER_AGENT_KIND } from './spec-blueprints.js'
import { ENVIRONMENT_ANALYST_KIND } from './environment-analyst.js'
import {
  ANALYSIS_AGENT_KIND,
  BUSINESS_DOCUMENTER_AGENT_KIND,
  MERGER_AGENT_KIND,
  MOCKER_AGENT_KIND,
  PLAYWRIGHT_AGENT_KIND,
  TESTER_AGENT_KIND,
} from './built-in-container.js'
import { UI_TESTER_AGENT_KIND } from '@cat-factory/contracts'
import { MEDIA_GENERATOR_AGENT_KIND } from './media.js'
import { TASK_REASSESSOR_AGENT_KIND } from '../prompts/roles.js'

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
// The guard covers EVERY container kind, built-in and deployment-authored alike. It used to be
// scoped to registered kinds only, with a blanket "the spec-aware-only built-ins (merger, testers,
// mocker, …) are out of scope by design" carve-out in this comment; now that every built-in is a
// real registration, that carve-out is gone and each of those kinds states its own reason below.
// A blanket exemption in prose is exactly the shape this guard exists to refuse.
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
  // Scores a diff's complexity / risk / impact. It JUDGES rather than produces, and a house coding
  // standard has no bearing on how risky a change is — the same reason it declares
  // `standardsDelivery: 'none'`, which is the stronger statement of this exemption.
  MERGER_AGENT_KIND,
  // The same judgement about the same diff, one step later: it re-scores complexity / risk / impact
  // against the change that landed. Exempt for the merger's reason, and it declares the same
  // `standardsDelivery: 'none'` for it.
  TASK_REASSESSOR_AGENT_KIND,
  // The testers RUN the service's suite and report what they observed. They are `spec-aware`, so
  // they read the in-repo spec that IS the contract under test; best-practice fragments describe
  // how code should be WRITTEN, which is not what a test run judges.
  TESTER_AGENT_KIND,
  UI_TESTER_AGENT_KIND,
  // Builds WireMock stubs from the upstream contracts, and authors end-to-end tests from the
  // acceptance criteria: both work from the spec (they are `spec-aware`) rather than from the
  // service's code-style standards.
  MOCKER_AGENT_KIND,
  PLAYWRIGHT_AGENT_KIND,
  // These two READ code and write prose about it (the domain-rules docs; the tech-debt report), and
  // shipped folding nothing. The exemption records that shipped behaviour rather than endorsing it:
  // both have a defensible claim on `code-aware` (an audit against the house standards is arguably
  // the whole point of the tech-debt report), and changing it is a prompt change on its own terms,
  // not a side effect of registering the kinds. Revisit deliberately.
  BUSINESS_DOCUMENTER_AGENT_KIND,
  ANALYSIS_AGENT_KIND,
  // Generates BINARY deliverables through a vendor API and stores them through a storage contract:
  // it writes no code and authors no prose, so neither fold has anything to give it. A technical
  // best-practice fragment says how code should be WRITTEN and a writing-style one how prose should
  // READ, and a rendered image is neither. It clones a repo for SCOPE alone (which subjects exist,
  // which of them lack an asset), never to contribute to it, and the trait guidance is explicit
  // that it commits no binaries. The same distinction `merger` is exempt on: this kind's output is
  // not a text the standards could describe.
  MEDIA_GENERATOR_AGENT_KIND,
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
