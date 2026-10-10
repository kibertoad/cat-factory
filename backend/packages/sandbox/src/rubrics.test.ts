import { describe, expect, it } from 'vitest'
import { type SandboxTaskType, SANDBOX_TASK_TYPES, rubricFor, weightedTotal } from './rubrics.js'

describe('rubricFor', () => {
  it('returns the dimension set for each task', () => {
    expect(rubricFor('code-review').dimensions.map((d) => d.key)).toContain('issue_detection')
    expect(rubricFor('implementation').dimensions.map((d) => d.key)).toContain('faithfulness')
    expect(rubricFor('requirement-review').dimensions.map((d) => d.key)).toContain('gap_coverage')
    expect(rubricFor('architecture-review').dimensions.map((d) => d.key)).toContain(
      'failure_mode_reasoning',
    )
    expect(rubricFor('bug-triage').dimensions.map((d) => d.key)).toContain('symptom_separation')
    expect(rubricFor('estimation').dimensions.map((d) => d.key)).toContain('axis_independence')
    expect(rubricFor('answer-recommendation').dimensions.map((d) => d.key)).toContain(
      'confidence_calibration',
    )
  })

  it('gives every shipped task a usable, uniquely-keyed, positively-weighted rubric', () => {
    // Derived from SANDBOX_TASK_TYPES rather than a hand-listed set: a rubric added without
    // dimensions, or with a duplicate key (which would make `weightedTotal` read one score twice),
    // fails here instead of grading every cell on a broken scale.
    for (const task of SANDBOX_TASK_TYPES) {
      const dims = rubricFor(task).dimensions
      expect(dims.length, `${task} has no dimensions`).toBeGreaterThan(0)
      const keys = dims.map((d) => d.key)
      expect(new Set(keys).size, `${task} has duplicate dimension keys`).toBe(keys.length)
      for (const dim of dims) {
        expect(dim.weight, `${task}/${dim.key} weight`).toBeGreaterThan(0)
        expect(dim.label.length, `${task}/${dim.key} label`).toBeGreaterThan(0)
        expect(dim.description.length, `${task}/${dim.key} description`).toBeGreaterThan(0)
      }
    }
  })

  it('keeps the technical-review rubrics free of the product-scope bar', () => {
    // The reason these rubrics exist. `product_scope` docks a finding for being technical, which
    // is exactly what a design critique and a bug triage are FOR: grading them on
    // `requirement-review` punished their highest-value findings (partition keys, durability,
    // session affinity). If someone re-adds that dimension to either, this fails.
    for (const task of ['architecture-review', 'bug-triage'] satisfies SandboxTaskType[]) {
      expect(rubricFor(task).dimensions.map((d) => d.key)).not.toContain('product_scope')
    }
    // ...while the two stages that DO settle the product layer keep it.
    for (const task of [
      'requirement-review',
      'answer-recommendation',
    ] satisfies SandboxTaskType[]) {
      expect(rubricFor(task).dimensions.map((d) => d.key)).toContain('product_scope')
    }
  })
})

describe('SANDBOX_TASK_TYPES', () => {
  it('lists exactly the tasks `rubricFor` can answer, with no duplicates', () => {
    expect(new Set(SANDBOX_TASK_TYPES).size).toBe(SANDBOX_TASK_TYPES.length)
    for (const task of SANDBOX_TASK_TYPES) expect(rubricFor(task).task).toBe(task)
  })
})

describe('weightedTotal', () => {
  it('computes the weighted mean using rubric weights', () => {
    // code-review weights: issue_detection 3, correctness 3, severity_order 1,
    // actionability 2, false_positives 2 → total weight 11.
    const scores = [
      { key: 'issue_detection', score: 5 },
      { key: 'correctness', score: 4 },
      { key: 'severity_order', score: 3 },
      { key: 'actionability', score: 4 },
      { key: 'false_positives', score: 2 },
    ]
    // (5*3 + 4*3 + 3*1 + 4*2 + 2*2) / 11 = (15+12+3+8+4)/11 = 42/11 = 3.818...
    expect(weightedTotal('code-review', scores)).toBe(3.82)
  })

  it('ignores unknown keys and missing dimensions', () => {
    expect(weightedTotal('code-review', [{ key: 'bogus', score: 5 }])).toBe(0)
  })

  it('weights only the dimensions present', () => {
    // Only issue_detection (w=3) present → mean is just its score.
    expect(weightedTotal('code-review', [{ key: 'issue_detection', score: 4 }])).toBe(4)
  })

  it('scores a full sheet for every shipped task within the 1..5 band', () => {
    // A rubric whose weights or keys drifted would show up here as a total outside the scale.
    for (const task of SANDBOX_TASK_TYPES) {
      const perfect = rubricFor(task).dimensions.map((d) => ({ key: d.key, score: 5 }))
      const floor = rubricFor(task).dimensions.map((d) => ({ key: d.key, score: 1 }))
      expect(weightedTotal(task, perfect), `${task} top`).toBe(5)
      expect(weightedTotal(task, floor), `${task} bottom`).toBe(1)
    }
  })
})
