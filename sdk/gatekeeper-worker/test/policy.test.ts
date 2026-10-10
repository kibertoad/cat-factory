// Compiling a policy: the rules this package enforces on whatever a deployment wrote. What a
// PARTICULAR policy grants is that deployment's own test (`deploy/gatekeeper/test/policy.test.ts`
// is the shipped example's), so every tier below is built for the rule it exercises.

import { describe, expect, it } from 'vitest'
import { GATEKEEPER_BINDINGS, bindingsWithinScope } from '@cat-factory/gatekeeper-bindings'
import { PolicyError } from '../src/errors.js'
import { compilePolicy, type GatekeeperPolicy } from '../src/policy/index.js'

function policyWith(tier: Partial<GatekeeperPolicy['tiers'][string]>): GatekeeperPolicy {
  return {
    defaultTier: null,
    tiers: {
      t: { description: 'test tier', keyScope: 'read', allow: [], ...tier },
    },
    grants: {},
  }
}

describe('compilePolicy', () => {
  it('refuses a tier whose keyScope the key endpoint cannot mint', () => {
    expect(() => compilePolicy(policyWith({ keyScope: 'admin', allow: [] }))).toThrow(PolicyError)
  })

  it('refuses a binding name the deployment does not serve', () => {
    expect(() => compilePolicy(policyWith({ allow: ['tasks_teleport'] }))).toThrow(
      /operation table does not carry/,
    )
  })

  it('refuses a grant above the tier’s own key scope, naming both scopes', () => {
    expect(() => compilePolicy(policyWith({ keyScope: 'read', allow: ['tasks_create'] }))).toThrow(
      /floor is 'write'.*keyScope is 'read'/s,
    )
  })

  it('refuses a deny naming an operation that does not exist', () => {
    expect(() => compilePolicy(policyWith({ allow: [], deny: ['tasks_teleport'] }))).toThrow(
      PolicyError,
    )
  })

  it('refuses a defaultTier and a grant that name an undeclared tier', () => {
    expect(() => compilePolicy({ ...policyWith({}), defaultTier: 'nope' })).toThrow(/defaultTier/)
    expect(() => compilePolicy({ ...policyWith({}), grants: { a: 'nope' } })).toThrow(
      /is not declared/,
    )
  })

  // The two lists are checked before they are applied, so a deny can legitimately name a binding
  // the allow list also names above scope: the operator is subtracting something they already
  // decided against, and refusing that would make cleaning up a policy impossible.
  it('admits an above-scope allow that a deny already removes', () => {
    const compiled = compilePolicy(
      policyWith({ keyScope: 'read', allow: ['tasks_create'], deny: ['tasks_create'] }),
    )
    expect(compiled.tiers.get('t')?.granted).toHaveLength(0)
  })
})

describe('what a compiled tier carries', () => {
  it('withholds a streaming binding for transport, not for policy', () => {
    const compiled = compilePolicy(policyWith({ keyScope: 'read', allow: '*' }))
    const tier = compiled.tiers.get('t')
    expect(tier?.granted.map((binding) => binding.name)).not.toContain('tasks_stream')
    expect(tier?.withheld.find((entry) => entry.name === 'tasks_stream')?.reason).toBe(
      'not_relayable',
    )
  })

  // The relation, not a count: every operation the deployment serves is accounted for exactly
  // once, whatever the surface grows to. A total pinned to a literal would fail on the next
  // ordinary endpoint and say nothing about what broke.
  it('accounts for every operation the deployment serves exactly once', () => {
    const compiled = compilePolicy(policyWith({ keyScope: 'write', allow: ['tasks_create'] }))
    const tier = compiled.tiers.get('t')
    const named = [
      ...(tier?.granted.map((binding) => binding.name) ?? []),
      ...(tier?.withheld.map((entry) => entry.name) ?? []),
    ]
    expect(new Set(named).size).toBe(named.length)
    expect(new Set(named)).toEqual(new Set(GATEKEEPER_BINDINGS.map((binding) => binding.name)))
  })

  it('names an above-scope operation as such rather than omitting it', () => {
    const compiled = compilePolicy(policyWith({ keyScope: 'read', allow: '*' }))
    const withheld = compiled.tiers.get('t')?.withheld ?? []
    const decide = withheld.find((entry) => entry.name === 'decisions_approve_step')
    expect(decide?.reason).toBe('above_key_scope')
  })

  it('grants every readable operation under a wildcard, minus the denies', () => {
    const compiled = compilePolicy(
      policyWith({ keyScope: 'read', allow: '*', deny: ['usage_get'] }),
    )
    const granted = new Set(compiled.tiers.get('t')?.granted.map((binding) => binding.name))
    const relayableReads = bindingsWithinScope('read').filter(
      (binding) => binding.result === 'value' && binding.name !== 'usage_get',
    )
    expect(granted).toEqual(new Set(relayableReads.map((binding) => binding.name)))
  })
})
