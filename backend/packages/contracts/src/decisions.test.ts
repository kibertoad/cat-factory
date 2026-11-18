import { describe, expect, it } from 'vitest'
import {
  type DecisionRegister,
  parseDecisionRegister,
  renderDecisionRegister,
  settleDecisionRegister,
} from './decisions.js'

const register: DecisionRegister = {
  summary: 'Two things to settle.',
  unanswered: [],
  items: [
    {
      id: 'overwrite',
      question: 'Overwrite existing translations?',
      options: ['overwrite', 'create only'],
      recommendation: 'overwrite',
      rationale: 'Lokalise is the source of truth.',
      evidence: [],
      decision: null,
    },
    {
      id: 'drafts',
      question: 'Write drafts only?',
      options: ['drafts', 'publish'],
      recommendation: 'drafts',
      rationale: '',
      evidence: [],
      decision: null,
    },
  ],
}

describe('settleDecisionRegister', () => {
  it('settles every item, accepting a choice outside the proposed options', () => {
    const settled = settleDecisionRegister(
      register,
      {
        decisions: [
          { itemId: 'overwrite', choice: 'overwrite', note: 'agreed' },
          { itemId: 'drafts', choice: 'drafts for new items only' },
        ],
      },
      'usr_1',
      5,
    )
    expect(settled.ok && settled.value.items.map((i) => i.decision)).toEqual([
      { choice: 'overwrite', note: 'agreed', decidedBy: 'usr_1', decidedAt: 5 },
      { choice: 'drafts for new items only', decidedBy: 'usr_1', decidedAt: 5 },
    ])
  })

  it('names every item left undecided, decided twice, or unknown', () => {
    expect(
      settleDecisionRegister(
        register,
        {
          decisions: [
            { itemId: 'overwrite', choice: 'a' },
            { itemId: 'overwrite', choice: 'b' },
            { itemId: 'ghost', choice: 'c' },
          ],
        },
        null,
        1,
      ),
    ).toEqual({
      ok: false,
      issues: ['overwrite: decided more than once', 'ghost: no such item', 'drafts: undecided'],
    })
    expect(settleDecisionRegister(register, null, null, 1).ok).toBe(false)
  })
})

describe('decision register', () => {
  it('refuses duplicate item ids and an empty register', () => {
    expect(
      parseDecisionRegister({ ...register, items: [register.items[0], register.items[0]] }).ok,
    ).toBe(false)
    expect(parseDecisionRegister({ summary: '', items: [] }).ok).toBe(false)
  })

  it('renders a settled item by its decision and an open one by its recommendation', () => {
    const settled = settleDecisionRegister(
      { ...register, items: [register.items[0]!] },
      { decisions: [{ itemId: 'overwrite', choice: 'create only' }] },
      null,
      1,
    )
    const text = renderDecisionRegister('Decisions', settled.ok ? settled.value : register)
    expect(text).toContain('Decided: create only')
    expect(renderDecisionRegister('Decisions', register)).toContain(
      'Not decided yet. Recommended: overwrite',
    )
  })
})
