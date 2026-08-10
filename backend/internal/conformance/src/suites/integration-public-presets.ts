import type { PublicTask } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// Cross-runtime conformance for the public PRESET surface: `GET /api/v1/model-presets`, and the
// `modelPresetId` / `riskPolicyId` a task create may pin.
//
// Its own file rather than more of `integration-public-board.ts` because that function hit the
// per-function line budget, and the split it wanted is this one: the board suite is about
// structure a caller creates, this is about which preset a run RESOLVES.
//
// What belongs here rather than in a unit test is what a unit test structurally cannot see: that
// each facade seeds the preset libraries into its OWN store and mounts the read, so a facade that
// shipped the controller without the seeding answers an empty list, and every task pinning a
// preset id then refuses on a deployment where the same call works everywhere else.

/** Mint a public-API key through the SESSION surface and return its bearer header. */
async function mintKey(
  app: Awaited<ReturnType<ConformanceHarness['makeApp']>>,
  workspaceId: string,
): Promise<Record<string, string>> {
  const created = await app.call<{ key: { id: string }; secret: string }>(
    'POST',
    `/workspaces/${workspaceId}/public-api-keys`,
    { label: 'conformance-presets', scope: 'admin' },
  )
  expect(created.status).toBe(201)
  return { authorization: `Bearer ${created.body.secret}` }
}

export function definePublicPresetConformance(harness: ConformanceHarness): void {
  describe('public API: pinning a preset on task create', () => {
    it('lists the model presets a task can pin, with exactly one default', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintKey(app, workspace.id)

      const listed = await app.call<{
        presets: { presetId: string; baseModelId: string; isDefault: boolean }[]
      }>('GET', '/api/v1/model-presets', undefined, admin)

      expect(listed.status).toBe(200)
      // A RELATION over a population this test does not own: the built-in catalog is seeded
      // elsewhere and gains members over time, so pinning a count here would fail on every
      // ordinary addition while saying nothing about what broke. What must hold whatever the
      // catalog contains is that a task pinning nothing resolves exactly one preset, and that
      // every row names a model to run on.
      expect(listed.body.presets.length).toBeGreaterThan(0)
      expect(listed.body.presets.filter((preset) => preset.isDefault)).toHaveLength(1)
      for (const preset of listed.body.presets) expect(preset.baseModelId).not.toBe('')
    })

    it('accepts a real preset id and REFUSES an unknown one rather than falling back', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintKey(app, workspace.id)
      const service = await app.call<{ serviceId: string }>(
        'POST',
        '/api/v1/services',
        { title: 'Preset pinning' },
        admin,
      )
      const tasks = `/api/v1/services/${service.body.serviceId}/tasks`
      const presets = await app.call<{ presets: { presetId: string }[] }>(
        'GET',
        '/api/v1/model-presets',
        undefined,
        admin,
      )
      const real = presets.body.presets[0]?.presetId ?? ''

      const pinned = await app.call<PublicTask>(
        'POST',
        tasks,
        { title: 'Runs on the pinned preset', modelPresetId: real },
        admin,
      )
      expect(pinned.status).toBe(201)

      // The refusal is the whole point of the field. Both knobs mean "the workspace default" when
      // OMITTED, so accepting an id nobody holds and then resolving that same default hands back a
      // 201 for a task running on something the caller did not choose, with nothing it can read
      // afterwards to tell the two apart.
      const badModel = await app.call<{ error: { details?: { reason?: string } } }>(
        'POST',
        tasks,
        { title: 'Typo', modelPresetId: 'mdp_nope' },
        admin,
      )
      expect(badModel.status).toBe(422)
      expect(badModel.body.error.details?.reason).toBe('model_preset_not_found')

      const badMerge = await app.call<{ error: { details?: { reason?: string } } }>(
        'POST',
        tasks,
        { title: 'Typo', riskPolicyId: 'rp_nope' },
        admin,
      )
      expect(badMerge.status).toBe(422)
      expect(badMerge.body.error.details?.reason).toBe('merge_preset_not_found')
    })

    it('refuses before the board changes, so a bad pin leaves no task behind', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintKey(app, workspace.id)
      const service = await app.call<{ serviceId: string }>(
        'POST',
        '/api/v1/services',
        { title: 'Nothing left behind' },
        admin,
      )
      const tasks = `/api/v1/services/${service.body.serviceId}/tasks`

      const refused = await app.call(
        'POST',
        tasks,
        { title: 'Ghost', modelPresetId: 'mdp_nope' },
        admin,
      )
      expect(refused.status).toBe(422)

      // The ordering rule this route is built on (`taskCreation.ts`): everything refusable is
      // refused before the write. A partial creation would be invisible to the caller, which got
      // an error, and permanent on the board.
      const listed = await app.call<{ tasks: PublicTask[] }>('GET', tasks, undefined, admin)
      expect(listed.body.tasks).toHaveLength(0)
    })
  })
}
