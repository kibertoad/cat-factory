// The policy this deployment ships, compiled against the LIVE operation table.
//
// It is the one test a copy of this template keeps and edits: the machinery's own rules are pinned
// by `@cat-factory/gatekeeper-worker`, and what is left for a deployment to prove is that ITS
// tiers grant what it believes they grant. Every assertion below is about a choice made in
// `src/policy.config.ts`, so an operator who changes that file should expect to change this one.

import { describe, expect, it } from 'vitest'
import {
  compilePolicy,
  DECISION_BINDINGS,
  TELEMETRY_BINDINGS,
  tierForActor,
} from '@cat-factory/gatekeeper-worker/policy'
import { POLICY } from '../src/policy.config'

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
  //
  // Asserted against `TELEMETRY_BINDINGS` rather than a transcribed list of names, per the repo's
  // rule about relations over populations a test does not own. The transcribed version was the
  // bug: it named the seven operations that existed when it was written, so the eighth (the LLM
  // export) shipped granted to a read-only tier with this test passing.
  it('grants no tier a read of captured run telemetry', () => {
    for (const tier of compiled.tiers.values()) {
      const granted = new Set(tier.granted.map((binding) => binding.name))
      expect(TELEMETRY_BINDINGS.filter((name) => granted.has(name))).toEqual([])
    }
  })

  // The other half of the same relation, and the reason the deny set is per-operation rather than
  // the whole `/debug` prefix: what a status Gadget needs must survive it.
  it('keeps the body-free run overviews readable for the observer tier', () => {
    const granted = new Set(compiled.tiers.get('observer')?.granted.map((binding) => binding.name))
    expect(granted).toContain('debug_list_runs')
    expect(granted).toContain('debug_get_run')
    expect(TELEMETRY_BINDINGS).not.toContain('debug_list_runs')
    expect(TELEMETRY_BINDINGS).not.toContain('debug_get_run')
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
