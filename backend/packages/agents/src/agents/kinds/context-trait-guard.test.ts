import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from './registry.js'
import { CODE_AWARE_TRAIT, DOC_AWARE_TRAIT, SPEC_AWARE_TRAIT, traitsFor } from './traits.js'
import { SPEC_WRITER_AGENT_KIND } from './spec-blueprints.js'
import { ENVIRONMENT_ANALYST_KIND } from './environment-analyst.js'

// Every registered kind that clones a repo must carry at least one CONTEXT trait
// (`code-aware` / `doc-aware` / `spec-aware`), so it is a DELIBERATE decision what guidance
// the agent receives. `code-aware`/`doc-aware` additionally trigger the best-practice / style
// fragment fold in `AgentContextBuilder.resolveFragments`; a repo-cloning kind with NO context
// trait silently drops the task's selected fragments and records 0 in the "Provided context"
// snapshot (the `pr-reviewer` bug). This guard turns that omission into a failing test.
//
// Scoped to REGISTERED kinds (the `registerAgentKind` extension seam — where new kinds, incl.
// deployment-authored ones, are added). Built-in non-registered kinds get their traits from
// `STANDARD_AGENT_TRAITS`, a small hand-maintained list where every container kind already
// carries a trait.
const CONTEXT_TRAITS = [CODE_AWARE_TRAIT, DOC_AWARE_TRAIT, SPEC_AWARE_TRAIT]

// Kinds that clone a repo but INTENTIONALLY receive no context trait, each with its reason.
// Adding a kind here must be a deliberate, reviewed choice — not a way to silence the guard.
const CONTEXT_TRAIT_OPT_OUT = new Set<string>([
  // Authors the spec from scratch: it consumes neither best-practice fragments nor the in-repo
  // spec (it IS the spec's author), so it is deliberately absent from every trait source.
  SPEC_WRITER_AGENT_KIND,
  // Reads the repo only to draft a Docker / runtime recipe; coding best-practice fragments and
  // the in-repo spec are not relevant to that output.
  ENVIRONMENT_ANALYST_KIND,
])

describe('registered container kinds carry a context trait', () => {
  const registry = defaultAgentKindRegistry()
  for (const def of registry.all()) {
    if (!registry.requiresContainer(def.kind)) continue
    it(`${def.kind} carries a context trait (or is a documented opt-out)`, () => {
      if (CONTEXT_TRAIT_OPT_OUT.has(def.kind)) return
      const traits = traitsFor(def.kind, registry)
      const hasContextTrait = CONTEXT_TRAITS.some((t) => traits.has(t))
      expect(
        hasContextTrait,
        `${def.kind} clones a repo but carries no context trait (code-aware/doc-aware/spec-aware). ` +
          `Add the appropriate trait so its context (best-practice fragments / spec guidance) is ` +
          `deliberately wired, or add it to CONTEXT_TRAIT_OPT_OUT with a justification.`,
      ).toBe(true)
    })
  }
})
