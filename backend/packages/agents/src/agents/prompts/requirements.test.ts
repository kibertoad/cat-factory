import { describe, expect, it } from 'vitest'
import { REVIEW_SYSTEM_PROMPT, REWORK_SYSTEM_PROMPT, WRITER_SYSTEM_PROMPT } from './requirements.js'

// The requirements-review stage settles the PRODUCT / BUSINESS layer only; the technical layer
// belongs to the later architect + researcher steps. The boundary only holds if all three agents
// in the flow state it — a reviewer that stays product-level, an incorporation editor that then
// writes a design into the document, and a Writer that recommends one, add up to no boundary at
// all — so these assert the shared block reached every one of them.

const FLOW_PROMPTS = [
  ['reviewer', REVIEW_SYSTEM_PROMPT],
  ['incorporation editor', REWORK_SYSTEM_PROMPT],
  ['Requirement Writer', WRITER_SYSTEM_PROMPT],
] as const

describe('requirements-review prompts', () => {
  for (const [role, prompt] of FLOW_PROMPTS) {
    describe(role, () => {
      it('states that the stage settles product / business requirements only', () => {
        expect(prompt).toContain('PRODUCT AND BUSINESS REQUIREMENTS ONLY')
        expect(prompt).toContain('never establishes HOW the software will be built')
      })

      it('defers the technical layer to the architect and researcher by name', () => {
        expect(prompt).toContain('ARCHITECT and RESEARCHER steps own it')
      })

      it('carries the product-owner test for keeping a point in scope', () => {
        expect(prompt).toContain('who does not read code')
      })
    })
  }

  it('tells the reviewer to drop a technical finding rather than downgrade its severity', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('does not become acceptable by carrying a low')
  })

  it('lets the reviewer raise nothing on purely technical work', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('Raising NOTHING is a valid and expected')
  })

  it("keeps the incorporated document free of the editor's own technical design", () => {
    expect(REWORK_SYSTEM_PROMPT).toContain('never introduce technical design of your own')
  })

  it('treats technical grounding as a constraint on a recommendation, not as its content', () => {
    expect(WRITER_SYSTEM_PROMPT).toContain('read a constraint out of it, do not')
  })
})
