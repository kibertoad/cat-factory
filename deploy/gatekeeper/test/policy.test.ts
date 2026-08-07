import { describe, expect, it } from 'vitest'
import { GATEKEEPER_BINDINGS, bindingsWithinScope } from '@cat-factory/gatekeeper-bindings'
import { DECISION_BINDINGS } from '../src/decisions'
import { PolicyError } from '../src/errors'
import { POLICY } from '../src/policy.config'
import { compilePolicy, tierForActor, type GatekeeperPolicy } from '../src/policy'

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

describe('the shipped policy', () => {
  const compiled = compilePolicy(POLICY)

  it('compiles', () => {
    expect([...compiled.tiers.keys()]).toEqual(['observer', 'operator', 'approver'])
  })

  it('refuses an actor with no grant, because it names no default tier', () => {
    expect(tierForActor(compiled, 'stranger@example.com')).toBeNull()
  })

  it('resolves a granted actor to their own tier', () => {
    expect(tierForActor(compiled, 'approver@example.com')?.name).toBe('approver')
  })

  // `notifications_act` can perform a real merge and `tasks_delete` is unrecoverable; both sit at
  // the `admin` floor, above every tier's key. So the assertion worth making is not that policy
  // omits them (it could not include them) but that a caller is TOLD why they are absent: an
  // agent that reads "not in policy" would go ask its operator for something no policy can grant.
  it('reports the merge-adjacent and destructive operations as above every tier’s key', () => {
    for (const tier of compiled.tiers.values()) {
      for (const name of ['notifications_act', 'tasks_delete']) {
        expect(tier.granted.map((binding) => binding.name)).not.toContain(name)
        expect(tier.withheld.find((entry) => entry.name === name)?.reason).toBe('above_key_scope')
      }
    }
  })

  // These carry model prompts, captured command output and agent search text. Every one is within
  // a `read` key's floor, so only the policy's own deny list keeps them from an OS agent.
  it('grants no tier the debug operations that return captured bodies', () => {
    const withBodies = [
      'debug_get_agent_context',
      'debug_get_llm_call',
      'debug_list_agent_context',
      'debug_list_llm_calls',
      'debug_list_logs',
      'debug_list_search_queries',
      'debug_list_tool_calls',
    ]
    for (const tier of compiled.tiers.values()) {
      const granted = new Set(tier.granted.map((binding) => binding.name))
      expect(withBodies.filter((name) => granted.has(name))).toEqual([])
    }
  })

  it('keeps the body-free run overviews readable for the observer tier', () => {
    const granted = new Set(compiled.tiers.get('observer')?.granted.map((binding) => binding.name))
    expect(granted).toContain('debug_list_runs')
    expect(granted).toContain('debug_get_run')
  })

  // The relation that makes `approver` a tier rather than a transcription. A run can park on
  // thirteen different things and each takes its own operations; the first cut of this policy
  // named fifteen decision bindings by hand and the surface has more than forty, so the tier
  // could answer the parks somebody remembered and reported every other one as stale.
  it('grants the approver tier everything answering a park takes', () => {
    const granted = new Set(compiled.tiers.get('approver')?.granted.map((b) => b.name))
    expect(DECISION_BINDINGS.filter((name) => !granted.has(name))).toEqual([])
  })

  // And the tier below it must NOT have them: `operator` is the delivery loop, and answering a
  // parked decision is what `approver` exists for.
  it('grants the operator tier no way to answer a parked decision', () => {
    const granted = new Set(compiled.tiers.get('operator')?.granted.map((b) => b.name))
    expect(
      DECISION_BINDINGS.filter((name) => name !== 'decisions_list' && granted.has(name)),
    ).toEqual([])
  })
})
