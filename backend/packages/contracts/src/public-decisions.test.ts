import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { docInterviewQaSchema } from './doc-interview.js'
import { initiativeQaSchema } from './initiative.js'
import { publicAnswerInterviewSchema, publicDecisionSchema } from './public-decisions.js'

/**
 * The public interview-answer body serves BOTH built-in interview gates through one route set, so
 * its bounds are a relation over two schemas this file does not own rather than a number of its
 * own: whatever either gate can STORE, this surface must be able to name and replace. Asserted
 * here rather than derived in the schema because the bound is published — see the note on
 * {@link publicAnswerInterviewSchema} for why deriving it would be the wrong direction of coupling.
 *
 * So this fails when a gate WIDENS its storage past what `/api/v1` accepts, which is exactly the
 * moment the public bound needs raising (additive, safe) instead of quietly refusing valid input.
 */
describe('publicAnswerInterviewBounds', () => {
  /** The `max_length` requirement on a (possibly optional-wrapped) string schema. */
  function maxLengthOf(schema: unknown): number {
    const unwrapped = (schema as { wrapped?: unknown }).wrapped ?? schema
    const pipe = (unwrapped as { pipe?: { type: string; requirement?: unknown }[] }).pipe ?? []
    const found = pipe.find((entry) => entry.type === 'max_length')
    expect(found, 'the gate schema must declare a max_length to compare against').toBeDefined()
    return found!.requirement as number
  }

  const publicBounds = {
    questionId: maxLengthOf(publicAnswerInterviewSchema.entries.questionId),
    answer: maxLengthOf(publicAnswerInterviewSchema.entries.answer),
  }

  it.each([
    { gate: 'initiative-interviewer', qa: initiativeQaSchema },
    { gate: 'doc-interviewer', qa: docInterviewQaSchema },
  ])('addresses every question $gate can store', ({ qa }) => {
    expect(publicBounds.questionId).toBeGreaterThanOrEqual(maxLengthOf(qa.entries.id))
    expect(publicBounds.answer).toBeGreaterThanOrEqual(maxLengthOf(qa.entries.answer))
  })

  it('accepts an EMPTY answer, which is how a caller undoes one', () => {
    // Both services accept it (clearing an answer recorded by mistake); a minimum length here
    // would make the public surface the only one that cannot undo.
    const cleared = v.safeParse(publicAnswerInterviewSchema, { questionId: 'q1', answer: '' })
    expect(cleared.success).toBe(true)
  })
})

/**
 * The decision variant list is what four generated SDKs branch on, and `kind` is what discriminates
 * it. A duplicate literal would make one of the two unreachable through the variant, and the shape
 * that hides it is exactly the shape this file is: kinds are declared one per schema, several files
 * apart from the list that unions them.
 */
describe('publicDecisionSchema', () => {
  it('discriminates every variant by a distinct `kind`', () => {
    const kinds = publicDecisionSchema.options.map(
      (option) => (option.entries.kind as { literal: string }).literal,
    )
    expect(new Set(kinds).size).toBe(kinds.length)
  })
})
