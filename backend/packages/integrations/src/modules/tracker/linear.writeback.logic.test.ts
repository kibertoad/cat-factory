import { describe, expect, it } from 'vitest'
import {
  buildLinearCommentVariables,
  buildLinearStateUpdateVariables,
  pickStateIdByType,
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

describe('pickStateIdByType', () => {
  it('picks the first completed-type state (the merge-resolve target)', () => {
    expect(
      pickStateIdByType(
        [
          { id: 's1', type: 'started' },
          { id: 's2', type: 'completed' },
          { id: 's3', type: 'completed' },
        ],
        'completed',
      ),
    ).toBe('s2')
  })

  it('picks the first started-type state (the intake in-progress mark)', () => {
    expect(
      pickStateIdByType(
        [
          { id: 's0', type: 'unstarted' },
          { id: 's1', type: 'started' },
          { id: 's2', type: 'started' },
          { id: 's3', type: 'completed' },
        ],
        'started',
      ),
    ).toBe('s1')
  })

  it('returns null when there is no state of the requested type', () => {
    expect(pickStateIdByType([{ id: 's1', type: 'started' }], 'completed')).toBeNull()
    expect(pickStateIdByType([{ id: 's3', type: 'completed' }], 'started')).toBeNull()
    expect(pickStateIdByType([], 'completed')).toBeNull()
  })
})
