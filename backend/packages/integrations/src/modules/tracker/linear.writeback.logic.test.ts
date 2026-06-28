import { describe, expect, it } from 'vitest'
import {
  buildLinearCommentVariables,
  buildLinearStateUpdateVariables,
  pickCompletedStateId,
} from './linear.writeback.logic.js'

describe('buildLinearCommentVariables', () => {
  it('targets the issue UUID with the Markdown body', () => {
    expect(buildLinearCommentVariables('uuid-1', 'hello').input).toEqual({
      issueId: 'uuid-1',
      body: 'hello',
    })
  })
})

describe('buildLinearStateUpdateVariables', () => {
  it('sets the state id on the issue', () => {
    const vars = buildLinearStateUpdateVariables('uuid-1', 'state-done')
    expect(vars).toEqual({ id: 'uuid-1', input: { stateId: 'state-done' } })
  })
})

describe('pickCompletedStateId', () => {
  it('picks the first completed-type state', () => {
    expect(
      pickCompletedStateId([
        { id: 's1', type: 'started' },
        { id: 's2', type: 'completed' },
        { id: 's3', type: 'completed' },
      ]),
    ).toBe('s2')
  })

  it('returns null when there is no completed state', () => {
    expect(pickCompletedStateId([{ id: 's1', type: 'started' }])).toBeNull()
    expect(pickCompletedStateId([])).toBeNull()
  })
})
