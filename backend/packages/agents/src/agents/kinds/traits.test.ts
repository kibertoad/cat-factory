import { DOC_INTERVIEWER_AGENT_KIND, INITIATIVE_INTERVIEWER_AGENT_KIND } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from './registry.js'
import {
  BRIEF_STANDARDS_TRAIT,
  CODE_AWARE_TRAIT,
  hasTrait,
  INTERVIEW_GATE_TRAIT,
  standardsVerbosityFor,
  traitDeliveryFor,
  traitGuidanceFor,
} from './traits.js'
import {
  FOUNDATIONAL_CATALOG_FILE,
  FOUNDATIONAL_DECLARATION_TAG,
  FOUNDATIONAL_INDEX_FILE,
} from '@cat-factory/kernel'
import { SPEC_OVERVIEW_PATH } from '@cat-factory/contracts'
import { systemPromptFor } from '../catalog.js'

// A fresh default registry carries every built-in kind, so the standard trait assignments resolve.
const registry = defaultAgentKindRegistry()

describe('interview-gate trait', () => {
  it('marks both interactive-interviewer gates', () => {
    // The engine keys its step re-park guard AND its approve/reject guard off this trait rather
    // than the individual kind ids, so a resumed interview (carrying `pendingInterview`) falls
    // through to the gate's own evaluation instead of being re-parked or settled via the plain
    // approval endpoint. If a new interviewer forgets the trait, its resume silently wedges — this
    // pins the two built-ins that must carry it.
    for (const kind of [INITIATIVE_INTERVIEWER_AGENT_KIND, DOC_INTERVIEWER_AGENT_KIND]) {
      expect(hasTrait(kind, INTERVIEW_GATE_TRAIT, registry)).toBe(true)
    }
  })

  it('does not bleed onto unrelated kinds', () => {
    expect(hasTrait('coder', INTERVIEW_GATE_TRAIT, registry)).toBe(false)
    // It is a pure marker: it must not accidentally imply the code-aware fragment fold.
    expect(hasTrait(INITIATIVE_INTERVIEWER_AGENT_KIND, CODE_AWARE_TRAIT, registry)).toBe(false)
  })
})

describe('brief-standards trait / standardsVerbosityFor', () => {
  it("marks the high-turn code-writing implementer kinds 'brief'", () => {
    // These run a long agentic loop whose system prompt (incl. every folded standard) is re-sent
    // each turn, so they fold the condensed `brief` variant to cut the per-turn context cost.
    for (const kind of ['coder', 'fixer', 'ci-fixer', 'conflict-resolver'] as const) {
      expect(hasTrait(kind, BRIEF_STANDARDS_TRAIT, registry)).toBe(true)
      expect(standardsVerbosityFor(kind, registry)).toBe('brief')
    }
  })

  it("leaves reviewer / planner / investigator kinds on the full 'full' standards", () => {
    // Few turns, and they benefit from the full standard text when polishing/judging built work.
    for (const kind of ['reviewer', 'architect', 'on-call'] as const) {
      expect(hasTrait(kind, BRIEF_STANDARDS_TRAIT, registry)).toBe(false)
      expect(standardsVerbosityFor(kind, registry)).toBe('full')
    }
  })
})

describe('trait guidance gated on what the dispatch DELIVERED', () => {
  // Every one of these sections opens by pointing at a `.cat-context/` file. The engine injects
  // none of them on a deployment with no `FoundationalServiceResolver` wired, and the guidance rode
  // the prompt anyway: a ~200-word reuse mandate naming a path that does not exist, re-sent on
  // every turn of the loop. The graders filed it repeatedly (kaizen KZ-0001).

  it('drops the catalog mandate when the catalog file was not injected', () => {
    const guidance = traitGuidanceFor('architect', registry, { contextPaths: [] }).join('\n')
    expect(guidance).not.toContain(FOUNDATIONAL_CATALOG_FILE)
    expect(guidance).not.toContain('FOUNDATIONAL SERVICES')
    // The other traits the architect carries are unaffected: gating is per trait, not per prompt.
    expect(guidance).toContain(SPEC_OVERVIEW_PATH)
  })

  it('keeps it when the file IS there, including an empty or unavailable catalog', () => {
    // Presence is the condition, not content. Where a resolver is wired the file is always
    // written and SAYS which state it is in (resolved / none registered / unavailable), and acting
    // on that statement is exactly what the guidance asks for.
    const guidance = traitGuidanceFor('architect', registry, {
      contextPaths: [FOUNDATIONAL_CATALOG_FILE],
    }).join('\n')
    expect(guidance).toContain(FOUNDATIONAL_CATALOG_FILE)
    expect(guidance).toContain(FOUNDATIONAL_DECLARATION_TAG)
  })

  it('gates the CONSUMER side on its own index file, not on the catalog', () => {
    const withIndex = traitGuidanceFor('coder', registry, {
      contextPaths: [FOUNDATIONAL_INDEX_FILE],
    }).join('\n')
    const without = traitGuidanceFor('coder', registry, {
      contextPaths: [FOUNDATIONAL_CATALOG_FILE],
    }).join('\n')
    expect(withIndex).toContain(FOUNDATIONAL_INDEX_FILE)
    expect(without).not.toContain(FOUNDATIONAL_INDEX_FILE)
  })

  it('renders everything when the caller does not KNOW what was delivered', () => {
    // Unknown and absent are opposite facts. The prompt editor measuring what an override cannot
    // delete, the sandbox composing a candidate and a plain unit test all legitimately have no
    // dispatch, and each must see the maximal prompt: over-reporting a rule costs a line, and
    // under-reporting hides one a workspace needs to know it cannot remove.
    const unknown = traitGuidanceFor('architect', registry).join('\n')
    expect(unknown).toContain(FOUNDATIONAL_CATALOG_FILE)
    expect(unknown).toEqual(traitGuidanceFor('architect', registry, {}).join('\n'))
  })

  it('reaches the same answer through the composed system prompt', () => {
    // The gate is worth nothing if it lives only in the helper: `systemPromptFor` is what a
    // dispatch actually sends, and it is the seam every executor threads the delivery through.
    const gated = systemPromptFor('architect', registry, undefined, { contextPaths: [] })
    const ungated = systemPromptFor('architect', registry)
    expect(ungated).toContain(FOUNDATIONAL_CATALOG_FILE)
    expect(gated).not.toContain(FOUNDATIONAL_CATALOG_FILE)
    // Nothing else moved: the read-only guardrail and the spec guidance are unconditional.
    expect(gated).toContain(SPEC_OVERVIEW_PATH)
  })

  it('builds one delivery set for every surface, from the run context', () => {
    expect(traitDeliveryFor({ injectedContextFiles: [{ path: 'a.md' }] })).toEqual({
      contextPaths: ['a.md'],
    })
    // Absent means the dispatch injected NOTHING, which is a known answer rather than an unknown
    // one: a surface that returned `{}` here would silently keep the dangling pointer.
    expect(traitDeliveryFor({})).toEqual({ contextPaths: [] })
  })
})
