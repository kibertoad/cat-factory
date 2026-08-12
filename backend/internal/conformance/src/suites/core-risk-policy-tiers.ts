import type { AccountRiskPolicy, RiskPolicyLibraryEntry } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from '../harness.js'

// Cross-runtime conformance for the ACCOUNT ⊕ WORKSPACE risk-policy tiers (ADR 0055).
//
// What only a real store can answer, and what a unit test over an in-memory fake structurally
// cannot: that each facade's account table, its board table and its suppression table compose into
// the SAME visible library, and that the ENGINE resolves a task pinning an inherited policy through
// that same composition. The precedence itself is pure kernel logic with its own unit tests; the
// risk here is a facade that maps a column differently or wires one of the three stores and not the
// others, which does not fail loudly — it hands a run a merge posture nobody chose.

/** A minimal account policy, distinctive enough that a mis-mapped column shows up as a value. */
function accountPolicy(over: Partial<AccountRiskPolicy> & { id: string }): AccountRiskPolicy {
  return {
    name: `policy ${over.id}`,
    maxComplexity: 0.31,
    maxRisk: 0.32,
    maxImpact: 0.33,
    ciMaxAttempts: 7,
    maxRequirementIterations: 4,
    maxRequirementConcernAllowed: 'low',
    maxTesterQualityIterations: 2,
    releaseWatchWindowMinutes: 45,
    releaseMaxAttempts: 2,
    humanReviewGraceMinutes: 15,
    judgeMinScore: 0.61,
    judgeMaxBounces: 3,
    autoMergeEnabled: false,
    forkDecision: null,
    classRules: { docs: 'always' },
    classRulesByRole: {},
    dryRunRoles: [],
    submissionClassesByRole: {},
    autonomy: 'attended',
    minAutoAnswerConfidence: 0.75,
    createdAt: 1_700_000_000_000,
    ...over,
  }
}

/** The board's visible library over HTTP, asserted to have loaded. */
async function library(app: ConformanceApp, wsId: string): Promise<RiskPolicyLibraryEntry[]> {
  const res = await app.call<RiskPolicyLibraryEntry[]>('GET', `/workspaces/${wsId}/risk-policies`)
  expect(res.status).toBe(200)
  return res.body
}

export function defineCoreRiskPolicyTiersConformance(harness: ConformanceHarness): void {
  describe('risk policy tiers (account ⊕ workspace)', () => {
    it('offers an account policy to a board in that account, tagged and read-only (D1 ⇄ Postgres)', async () => {
      const app = harness.makeApp()
      // An ORG board, because inheritance needs a real account: `createWorkspace` is the
      // accountless shape, where the merge has nothing above it to read.
      const { workspace } = await app.createOrgWorkspace()
      const accountId = await app.workspaceRepository().accountOf(workspace.id)
      expect(accountId, 'an org board must resolve an account to inherit from').toBeTruthy()
      const policy = accountPolicy({ id: 'mp_org_wide' })
      await app.accountRiskPolicyRepository().upsert(accountId!, policy)

      const entries = await library(app, workspace.id)
      const inherited = entries.find((entry) => entry.id === 'mp_org_wide')
      expect(inherited?.tier).toBe('account')
      // Every column round-trips: the numbers the merge decision reads, the JSON class rules, and
      // the two default claims an account row CANNOT hold (stated false, never stored).
      expect(inherited).toMatchObject({
        name: 'policy mp_org_wide',
        maxRisk: 0.32,
        ciMaxAttempts: 7,
        autoMergeEnabled: false,
        classRules: { docs: 'always' },
        minAutoAnswerConfidence: 0.75,
        isDefault: false,
        isUnattendedDefault: false,
      })
      // The board's own seeded built-ins are still there and still its own.
      expect(entries.some((entry) => entry.tier === 'workspace')).toBe(true)

      // An inherited policy is not the board's to change: both writes refuse with the reason that
      // names the remedy, rather than the bare 404 a workspace-tier-only read would produce.
      const patch = await app.call(
        'PATCH',
        `/workspaces/${workspace.id}/risk-policies/mp_org_wide`,
        { maxRisk: 0.9 },
      )
      expect(patch.status).toBe(409)
      expect(
        (patch.body as { error?: { details?: { reason?: string } } }).error?.details?.reason,
      ).toBe('risk_policy_inherited')
      const deleted = await app.call(
        'DELETE',
        `/workspaces/${workspace.id}/risk-policies/mp_org_wide`,
      )
      expect(deleted.status).toBe(409)
    })

    it('never leaks a policy from ANOTHER account', async () => {
      const app = harness.makeApp()
      const [own, foreign] = await Promise.all([app.createOrgWorkspace(), app.createOrgWorkspace()])
      const foreignAccount = await app.workspaceRepository().accountOf(foreign.workspace.id)
      await app
        .accountRiskPolicyRepository()
        .upsert(foreignAccount!, accountPolicy({ id: 'mp_foreign' }))

      const entries = await library(app, own.workspace.id)
      expect(entries.some((entry) => entry.id === 'mp_foreign')).toBe(false)
    })

    it('clones an inherited policy into a row the board owns, under a fresh id', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const accountId = await app.workspaceRepository().accountOf(workspace.id)
      await app
        .accountRiskPolicyRepository()
        .upsert(accountId!, accountPolicy({ id: 'mp_source', maxRisk: 0.42 }))

      const cloned = await app.call<RiskPolicyLibraryEntry>(
        'POST',
        `/workspaces/${workspace.id}/risk-policies/mp_source/clone`,
        { name: 'Board copy' },
      )
      expect(cloned.status).toBe(201)
      expect(cloned.body.tier).toBe('workspace')
      expect(cloned.body.name).toBe('Board copy')
      // A FRESH id, never an override of the account's: an override sharing the id would re-point
      // every task already filed against the account's posture the moment the board edited it.
      expect(cloned.body.id).not.toBe('mp_source')
      // The numbers came across, and the copy claims neither default.
      expect(cloned.body).toMatchObject({
        maxRisk: 0.42,
        isDefault: false,
        isUnattendedDefault: false,
      })

      // The clone is editable where its source was not, which is the entire point of the action.
      const patched = await app.call(
        'PATCH',
        `/workspaces/${workspace.id}/risk-policies/${cloned.body.id}`,
        { maxRisk: 0.11 },
      )
      expect(patched.status).toBe(200)

      // And the account's own policy is untouched and still offered, on both tiers' terms.
      const entries = await library(app, workspace.id)
      expect(entries.find((entry) => entry.id === 'mp_source')).toMatchObject({
        tier: 'account',
        maxRisk: 0.42,
      })
      expect(entries.find((entry) => entry.id === cloned.body.id)).toMatchObject({
        tier: 'workspace',
        maxRisk: 0.11,
      })
    })

    it('hides an inherited policy on request, and offers it again when restored', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const wsId = workspace.id
      const accountId = await app.workspaceRepository().accountOf(wsId)
      await app
        .accountRiskPolicyRepository()
        .upsert(accountId!, accountPolicy({ id: 'mp_hide_me' }))

      const hidden = await app.call(
        'POST',
        `/workspaces/${wsId}/risk-policies/mp_hide_me/suppression`,
      )
      expect(hidden.status).toBe(204)
      expect((await library(app, wsId)).some((entry) => entry.id === 'mp_hide_me')).toBe(false)

      // The suppression LIST is what makes hiding reversible: the hidden id is by construction
      // absent from the library above, so without this read the board could offer no way back.
      const suppressions = await app.call<{ id: string; name: string; inherited: boolean }[]>(
        'GET',
        `/workspaces/${wsId}/risk-policy-suppressions`,
      )
      expect(suppressions.status).toBe(200)
      expect(suppressions.body).toEqual([
        { id: 'mp_hide_me', name: 'policy mp_hide_me', inherited: true },
      ])

      // Hiding is idempotent: a double-click is the same state, not a second row or a failure.
      expect(
        (await app.call('POST', `/workspaces/${wsId}/risk-policies/mp_hide_me/suppression`)).status,
      ).toBe(204)
      expect(
        (await app.call<{ id: string }[]>('GET', `/workspaces/${wsId}/risk-policy-suppressions`))
          .body,
      ).toHaveLength(1)

      // A suppression whose account policy is withdrawn HIDES NOTHING, and says so rather than
      // reading as a posture still being withheld.
      await app.accountRiskPolicyRepository().remove(accountId!, 'mp_hide_me')
      expect(
        (
          await app.call<{ id: string; inherited: boolean }[]>(
            'GET',
            `/workspaces/${wsId}/risk-policy-suppressions`,
          )
        ).body,
      ).toEqual([{ id: 'mp_hide_me', name: 'mp_hide_me', inherited: false }])

      // Restore drops the suppression, so a re-authored policy of that id is offered again.
      expect(
        (await app.call('DELETE', `/workspaces/${wsId}/risk-policies/mp_hide_me/suppression`))
          .status,
      ).toBe(204)
      await app
        .accountRiskPolicyRepository()
        .upsert(accountId!, accountPolicy({ id: 'mp_hide_me' }))
      expect((await library(app, wsId)).some((entry) => entry.id === 'mp_hide_me')).toBe(true)
    })

    it('lets the board OWN row win a collision, so a tightened built-in survives', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const accountId = await app.workspaceRepository().accountOf(workspace.id)
      // Every board is seeded with the built-in ids, so an account authoring one collides with a row
      // the board already owns. Asserted against a real store because the collision is only visible
      // once both tables hold the id.
      const seeded = (await library(app, workspace.id)).find((entry) => entry.tier === 'workspace')!
      await app
        .accountRiskPolicyRepository()
        .upsert(accountId!, accountPolicy({ id: seeded.id, maxRisk: 0.99 }))

      const entries = await library(app, workspace.id)
      const collided = entries.filter((entry) => entry.id === seeded.id)
      expect(collided).toHaveLength(1)
      expect(collided[0]).toMatchObject({ tier: 'workspace', maxRisk: seeded.maxRisk })
    })

    it('lets a task PIN an inherited policy, and the engine resolves that policy', async () => {
      const app = harness.makeApp()
      const { workspace, blocks } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const accountId = await app.workspaceRepository().accountOf(wsId)
      await app
        .accountRiskPolicyRepository()
        .upsert(accountId!, accountPolicy({ id: 'mp_inherited_pin' }))

      // The PIN GUARD reads the same merged library, so an inherited id is accepted at the write
      // door. Reading the board tier alone here would refuse exactly what the picker offers, which
      // is the failure this assertion exists for: a dangling pin is refused at creation.
      const frame = blocks.find((block) => block.level === 'frame')
      expect(
        frame,
        'the seeded board must offer a service frame to file the task under',
      ).toBeTruthy()
      const task = await app.call<{ id: string; riskPolicyId?: string | null }>(
        'POST',
        `/workspaces/${wsId}/blocks/${frame!.id}/tasks`,
        { title: 'Pinned to the org policy', riskPolicyId: 'mp_inherited_pin' },
      )
      expect(task.status).toBe(201)
      expect(task.body.riskPolicyId).toBe('mp_inherited_pin')

      // And the pin RESOLVES: hiding the policy afterwards is what proves the engine reads it
      // through the merged view rather than off the block. A hidden pin falls back to the board's
      // default — the same disposition a deleted local policy has — so the two reads differ.
      const before = await library(app, wsId)
      expect(before.find((entry) => entry.id === 'mp_inherited_pin')?.tier).toBe('account')
      await app.call('POST', `/workspaces/${wsId}/risk-policies/mp_inherited_pin/suppression`)
      const after = await library(app, wsId)
      expect(after.some((entry) => entry.id === 'mp_inherited_pin')).toBe(false)
    })
  })
}
