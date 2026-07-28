import { DOC_INTERVIEWER_AGENT_KIND, INITIATIVE_INTERVIEWER_AGENT_KIND } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from './registry.js'
import {
  BRIEF_STANDARDS_TRAIT,
  CODE_AWARE_TRAIT,
  hasTrait,
  INTERVIEW_GATE_TRAIT,
  standardsVerbosityFor,
} from './traits.js'

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
