import type { PublicTask } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from '../harness.js'
import { mintPublicApiKey } from './shared.js'

// Cross-runtime conformance for the public PRESET surface: `GET /api/v1/model-presets`,
// `GET /api/v1/risk-policies`, and the `modelPresetId` / `riskPolicyId` a task may pin.
//
// Its own file rather than more of `integration-public-board.ts` because that function hit the
// per-function line budget, and the split it wanted is this one: the board suite is about
// structure a caller creates, this is about which preset a run RESOLVES.
//
// What belongs here rather than in a unit test is what a unit test structurally cannot see: that
// each facade seeds the two libraries into its OWN store and mounts both reads, so a facade that
// shipped the controller without the seeding answers an empty list, and every task pinning an id
// then refuses on a deployment where the same call works everywhere else.

/** The libraries a task can pin from, and the two ids this suite drives the pins with. */
async function readLibraries(
  app: ConformanceApp,
  admin: Record<string, string>,
): Promise<{ modelPresetId: string; riskPolicyId: string }> {
  const presets = await app.call<{ presets: { presetId: string }[] }>(
    'GET',
    '/api/v1/model-presets',
    undefined,
    admin,
  )
  const policies = await app.call<{ policies: { policyId: string }[] }>(
    'GET',
    '/api/v1/risk-policies',
    undefined,
    admin,
  )
  // ASSERTED, not defaulted. An unwired facade answers 503 and an unseeded one answers an empty
  // list, which are exactly the regressions this file exists to catch; letting either fall through
  // to `?? ''` would report them as a 400 on the PIN assertion below, naming the wrong thing.
  expect(presets.status).toBe(200)
  expect(policies.status).toBe(200)
  expect(presets.body.presets.length).toBeGreaterThan(0)
  expect(policies.body.policies.length).toBeGreaterThan(0)
  return {
    modelPresetId: presets.body.presets[0]!.presetId,
    riskPolicyId: policies.body.policies[0]!.policyId,
  }
}

/** A service to file tasks under, failing HERE if the create did rather than at the first pin. */
async function createService(
  app: ConformanceApp,
  admin: Record<string, string>,
  title: string,
): Promise<string> {
  const service = await app.call<{ serviceId: string }>(
    'POST',
    '/api/v1/services',
    { title },
    admin,
  )
  expect(service.status).toBe(201)
  return service.body.serviceId
}

export function definePublicPresetConformance(harness: ConformanceHarness): void {
  describe('public API: pinning a preset on task create', () => {
    it('lists both libraries a task can pin, each with exactly one default', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'presets')

      const presets = await app.call<{
        presets: { presetId: string; baseModelId: string; isDefault: boolean }[]
      }>('GET', '/api/v1/model-presets', undefined, admin)
      const policies = await app.call<{
        policies: {
          policyId: string
          isDefault: boolean
          isUnattendedDefault: boolean
          autonomy: string
        }[]
      }>('GET', '/api/v1/risk-policies', undefined, admin)

      expect(presets.status).toBe(200)
      expect(policies.status).toBe(200)
      // A RELATION over a population this test does not own: both built-in catalogs are seeded
      // elsewhere and gain members over time, so pinning a count here would fail on every ordinary
      // addition while saying nothing about what broke. What must hold whatever they contain is
      // that a task pinning nothing resolves exactly one row from each, and that every model
      // preset names a model to run on.
      expect(presets.body.presets.length).toBeGreaterThan(0)
      expect(presets.body.presets.filter((preset) => preset.isDefault)).toHaveLength(1)
      expect(policies.body.policies.filter((policy) => policy.isDefault)).toHaveLength(1)
      // The SECOND default, and the one a key-authenticated caller's own runs resolve. Asserted
      // separately from `isDefault` for the reason the seed test asserts them separately: a
      // facade whose seeding wrote only the in-app flag leaves every run this API starts on
      // `FALLBACK_RISK_POLICY`, which auto-merges nothing, and the totals would still come to one.
      const unattended = policies.body.policies.filter((policy) => policy.isUnattendedDefault)
      expect(unattended).toHaveLength(1)
      // And it is a policy that can actually finish without a person, which is the whole reason a
      // second default exists rather than one shared row.
      expect(unattended[0]!.autonomy).toBe('unattended')
      for (const preset of presets.body.presets) expect(preset.baseModelId).not.toBe('')
    })

    it('lands a real pin ON the task, and REFUSES an unknown one rather than falling back', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'presets')
      const tasks = `/api/v1/services/${await createService(app, admin, 'Preset pinning')}/tasks`
      const pins = await readLibraries(app, admin)

      const pinned = await app.call<PublicTask>(
        'POST',
        tasks,
        { title: 'Runs on the pinned preset', ...pins },
        admin,
      )
      expect(pinned.status).toBe(201)
      // The 201 alone would pass on a route that accepted both ids and DROPPED them, which is the
      // whole failure mode: the task would run on the workspace default and read, ever after,
      // exactly like a task that asked for it. Both halves are asserted: what the creation
      // answered, and what a fresh read of the row says.
      expect(pinned.body).toMatchObject(pins)
      const reread = await app.call<PublicTask>(
        'GET',
        `/api/v1/tasks/${pinned.body.taskId}`,
        undefined,
        admin,
      )
      expect(reread.body).toMatchObject(pins)

      // The refusal is the other half of the point. Both knobs mean "the workspace default" when
      // OMITTED, so accepting an id nobody holds and then resolving that same default hands back a
      // 201 for a task running on something the caller did not choose.
      const badModel = await app.call<{ error: { details?: { reason?: string } } }>(
        'POST',
        tasks,
        { title: 'Typo', modelPresetId: 'mdp_nope' },
        admin,
      )
      expect(badModel.status).toBe(422)
      expect(badModel.body.error.details?.reason).toBe('model_preset_not_found')

      const badPolicy = await app.call<{ error: { details?: { reason?: string } } }>(
        'POST',
        tasks,
        { title: 'Typo', riskPolicyId: 'mp_nope' },
        admin,
      )
      expect(badPolicy.status).toBe(422)
      expect(badPolicy.body.error.details?.reason).toBe('risk_policy_not_found')
    })

    it('re-points a pin by patch, and refuses a dangling one there too', async () => {
      // The patch half exists so a wrong pin can be CORRECTED. Without it the only repair is
      // deleting the task, which loses the id every stored reference points at, its ticket claim
      // and its attached documents.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'presets')
      const tasks = `/api/v1/services/${await createService(app, admin, 'Re-pointing')}/tasks`
      const pins = await readLibraries(app, admin)

      const created = await app.call<PublicTask>('POST', tasks, { title: 'Unpinned' }, admin)
      expect(created.status).toBe(201)
      expect(created.body.modelPresetId).toBeNull()

      const patched = await app.call<PublicTask>(
        'PATCH',
        `/api/v1/tasks/${created.body.taskId}`,
        { modelPresetId: pins.modelPresetId },
        admin,
      )
      expect(patched.status).toBe(200)
      expect(patched.body.modelPresetId).toBe(pins.modelPresetId)
      // Untouched by a patch that never named it, which is what "omitted means unchanged" has to
      // mean for a field whose empty value is also its unpinned value.
      expect(patched.body.riskPolicyId).toBeNull()

      const refused = await app.call<{ error: { details?: { reason?: string } } }>(
        'PATCH',
        `/api/v1/tasks/${created.body.taskId}`,
        { riskPolicyId: 'mp_nope' },
        admin,
      )
      expect(refused.status).toBe(422)
      expect(refused.body.error.details?.reason).toBe('risk_policy_not_found')
    })

    it('refuses before the board changes, so a bad pin leaves no task behind', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'presets')
      const tasks = `/api/v1/services/${await createService(app, admin, 'Nothing left behind')}/tasks`

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

    it('does not hand a WRITE key the library a read of it needs admin for', async () => {
      // `write` is task create's floor and `admin` is both lists', so a refusal that named the
      // available ids would let the lower rung enumerate, by typo, exactly what the higher one
      // gates. The message names what MISSED and the reason names which library; neither says
      // what the workspace holds.
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace()
      const admin = await mintPublicApiKey(app, workspace.id, 'admin', 'presets')
      const write = await mintPublicApiKey(app, workspace.id, 'write', 'presets')
      const tasks = `/api/v1/services/${await createService(app, admin, 'Scope floor')}/tasks`
      const pins = await readLibraries(app, admin)

      const refused = await app.call<{ error: { message: string; details?: unknown } }>(
        'POST',
        tasks,
        { title: 'Typo', modelPresetId: 'mdp_nope' },
        write,
      )
      expect(refused.status).toBe(422)
      expect(JSON.stringify(refused.body)).not.toContain(pins.modelPresetId)
      expect((await app.call('GET', '/api/v1/model-presets', undefined, write)).status).toBe(403)
    })
  })
}
