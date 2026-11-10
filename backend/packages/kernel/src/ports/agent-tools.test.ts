import { describe, expect, it } from 'vitest'
import { toolSecretSubjectOf } from './agent-tools.js'

describe('toolSecretSubjectOf', () => {
  it('reads a persisted declarer back as the subject it names', () => {
    expect(toolSecretSubjectOf({ kind: 'project-definition', id: 'research/acme:vendor' })).toEqual(
      {
        kind: 'project-definition',
        id: 'research/acme:vendor',
      },
    )
  })

  it('names no subject for a kind the platform does not resolve', () => {
    expect(toolSecretSubjectOf({ kind: 'retired-kind', id: 'x' })).toBeUndefined()
    // An inherited property is not a kind, so a crafted record cannot pass as one.
    expect(toolSecretSubjectOf({ kind: 'toString', id: 'x' })).toBeUndefined()
  })
})
