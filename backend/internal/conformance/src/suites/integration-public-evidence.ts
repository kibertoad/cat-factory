import type { ExecutionInstance, Pipeline } from '@cat-factory/kernel'
import {
  parsePrVerificationReport,
  parseRunOutcome,
  PR_VERIFICATION_REPORT_VERSION,
  RUN_OUTCOME_VERSION,
  type PublicApiKey,
  type PublicRunArtifactList,
} from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { memoryBinaryArtifactStore } from './shared.js'

// Cross-runtime conformance for the public run-EVIDENCE surface (`/api/v1/runs/:runId/report`,
// `…/outcome`, `…/artifacts`, `/api/v1/artifacts/:id/blob`) and for HEADLESS key provisioning
// (`/api/v1/keys`).
//
// What belongs HERE rather than in a unit test is the half a unit test structurally cannot see:
// that each facade MOUNTS these routes, composes the report from its OWN execution store, resolves
// the artifact store its own way, and (for the keys) that the provisioning cascade runs against
// the real SQL of both stores. A facade that shipped the controller but forgot a wiring answers
// 404/503 here instead of shipping a surface a trial harness silently cannot use.
//
// See backend/docs/public-api.md and backend/docs/adr/0043-public-decision-surface.md.

/** Mint a public-API key through the SESSION surface and return its bearer header. */
async function mintKey(
  app: Awaited<ReturnType<ConformanceHarness['makeApp']>>,
  workspaceId: string,
  scope: 'read' | 'write' | 'decide' | 'admin',
): Promise<Record<string, string>> {
  const created = await app.call<{ key: { id: string }; secret: string }>(
    'POST',
    `/workspaces/${workspaceId}/public-api-keys`,
    { label: `conformance-evidence-${scope}`, scope },
  )
  expect(created.status).toBe(201)
  return { authorization: `Bearer ${created.body.secret}` }
}

/**
 * The opaque identity a provisioner attaches to a per-person key. Shaped like something an
 * external system would actually send (a namespaced id, not a bare word), because the platform
 * stores it verbatim and must never be tempted to parse it.
 */
const IDENTITY = 'os-user:ada@example.com'

/** A one-step run on the seeded login task, which is what the evidence reads are addressed by. */
async function startRun(
  app: Awaited<ReturnType<ConformanceHarness['makeApp']>>,
  workspaceId: string,
): Promise<string> {
  const pipeline = await app.call<Pipeline>('POST', `/workspaces/${workspaceId}/pipelines`, {
    name: 'Coder only',
    agentKinds: ['coder'],
  })
  const started = await app.call<ExecutionInstance>(
    'POST',
    `/workspaces/${workspaceId}/blocks/task_login/executions`,
    { pipelineId: pipeline.body.id },
  )
  expect(started.status).toBe(201)
  return started.body.id
}

/**
 * The two cases split into their own functions rather than one long body: they share the file
 * because a provisioned key is what every evidence read is addressed with, and nothing else.
 */
export function definePublicEvidenceConformance(harness: ConformanceHarness): void {
  defineRunEvidenceCases(harness)
  defineKeyProvisioningCases(harness)
}

/** `/api/v1/runs/:runId/report`, `…/outcome`, `…/artifacts`, `/api/v1/artifacts/:id/blob`. */
function defineRunEvidenceCases(harness: ConformanceHarness): void {
  describe('public API: run evidence', () => {
    it("composes a run's verification report on read, for a run with no pull request", async () => {
      const app = harness.makeApp()
      // Public-API keys are ACCOUNT-scoped, so the mint route refuses an account-less board.
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const auth = await mintKey(app, wsId, 'read')
      const runId = await startRun(app, wsId)

      const read = await app.call('GET', `/api/v1/runs/${runId}/report`, undefined, auth)
      expect(read.status).toBe(200)
      // Parsed against the contract rather than spot-checked: the whole promise of this endpoint
      // is that what it serves IS the report shape, so an emitter that drifted from the schema
      // must fail here and not at whatever a consumer happens to read first.
      const report = parsePrVerificationReport(read.body)
      expect(report.version).toBe(PR_VERIFICATION_REPORT_VERSION)
      expect(report.run.executionId).toBe(runId)
      expect(report.run.blockId).toBe('task_login')
      // No publisher is wired in conformance, so nothing resolved a pull request. The read still
      // answers. That is the difference from the publish path, and the point of the endpoint for
      // headless jobs and runs that fail before they push.
      expect(report.run.repo).toBeNull()
      // A pipeline of one `coder` produced no CI verdict and no tester report, and the report
      // SAYS so rather than omitting the sections: "no gate ran" and "the gate found nothing"
      // must never read the same to a machine either.
      expect(report.ci.status).toBe('absent')
      expect(report.ci.note).toBeTruthy()
      expect(report.tests.status).toBe('absent')
      // Same rule for what the run built FROM: this task linked no page, and the section says so
      // rather than being omitted, so a consumer can tell "nothing was attached" from a report
      // written before the section existed.
      expect(report.context.status).toBe('absent')
      expect(report.context.note).toBeTruthy()
    })

    it("composes a run's OUTCOME summary from the same evidence as its report", async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const auth = await mintKey(app, wsId, 'read')
      const runId = await startRun(app, wsId)

      const read = await app.call('GET', `/api/v1/runs/${runId}/outcome`, undefined, auth)
      expect(read.status).toBe(200)
      const outcome = parseRunOutcome(read.body)
      expect(outcome.version).toBe(RUN_OUTCOME_VERSION)
      expect(outcome.title).toBeTruthy()

      // The half only a cross-surface assertion can see: this facade's outcome read and its report
      // read must describe ONE run. A facade that wired a second loader (or a second composer)
      // passes both endpoints' own tests and fails here.
      const reported = await app.call('GET', `/api/v1/runs/${runId}/report`, undefined, auth)
      const report = parsePrVerificationReport(reported.body)
      expect(outcome.title).toBe(report.run.blockTitle)
      // A pipeline of one `coder` ran no tester, and BOTH documents say so in their own vocabulary
      // rather than either of them rendering an empty coverage section as a clean one.
      expect(report.tests.status).toBe('absent')
      expect(outcome.tests).toEqual({ status: 'absent', gap: 'no_tester_step' })
      expect(outcome.requirements).toEqual({ status: 'absent', gap: 'no_tester_step' })
    })

    it('refuses an unknown run, and refuses every read without a key', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const auth = await mintKey(app, wsId, 'read')
      const runId = await startRun(app, wsId)

      const missing = await app.call('GET', '/api/v1/runs/exec_nope/report', undefined, auth)
      expect(missing.status).toBe(404)

      const missingOutcome = await app.call(
        'GET',
        '/api/v1/runs/exec_nope/outcome',
        undefined,
        auth,
      )
      expect(missingOutcome.status).toBe(404)

      const anonymous = await app.call('GET', `/api/v1/runs/${runId}/report`, undefined)
      expect(anonymous.status).toBe(401)
      const anonymousOutcome = await app.call('GET', `/api/v1/runs/${runId}/outcome`, undefined)
      expect(anonymousOutcome.status).toBe(401)
      const anonymousList = await app.call('GET', `/api/v1/runs/${runId}/artifacts`, undefined)
      expect(anonymousList.status).toBe(401)
    })

    it("lists a run's artifacts and serves their bytes to the key that owns them", async () => {
      const store = memoryBinaryArtifactStore()
      const app = harness.makeApp(undefined, {
        resolveBinaryArtifactStore: () => Promise.resolve(store),
      })
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const auth = await mintKey(app, wsId, 'read')
      const runId = await startRun(app, wsId)

      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      store.seed(
        {
          id: 'art_1',
          workspaceId: wsId,
          executionId: runId,
          blockId: 'task_login',
          kind: 'screenshot',
          view: 'login',
          contentType: 'image/png',
          byteSize: bytes.byteLength,
          hash: 'deadbeef',
          storage: 'memory',
          storageKey: 'art_1',
          createdAt: 1_700_000_000_000,
        },
        bytes,
      )

      const listed = await app.call<PublicRunArtifactList>(
        'GET',
        `/api/v1/runs/${runId}/artifacts`,
        undefined,
        auth,
      )
      expect(listed.status).toBe(200)
      expect(listed.body.artifacts).toEqual([
        {
          artifactId: 'art_1',
          kind: 'screenshot',
          view: 'login',
          contentType: 'image/png',
          byteSize: bytes.byteLength,
          hash: 'deadbeef',
          createdAt: 1_700_000_000_000,
        },
      ])
      // The storage vocabulary never crosses the wire: the bytes endpoint exists to hide which
      // backend holds them, so a row that leaked `storageKey` would hand a caller an object key
      // it has no business knowing.
      expect(JSON.stringify(listed.body)).not.toContain('storageKey')

      const blob = await app.callBinary('GET', '/api/v1/artifacts/art_1/blob', auth)
      expect(blob.status).toBe(200)
      expect([...blob.bytes]).toEqual([...bytes])
      // Clamped to the image allow-list, so a stored row can never be served as active content.
      expect(blob.contentType).toBe('image/png')

      const unknown = await app.callBinary('GET', '/api/v1/artifacts/art_nope/blob', auth)
      expect(unknown.status).toBe(404)
      const anonymous = await app.callBinary('GET', '/api/v1/artifacts/art_1/blob')
      expect(anonymous.status).toBe(401)
    })

    it("refuses another workspace's artifact, and 404s an unknown run rather than listing nothing", async () => {
      const store = memoryBinaryArtifactStore()
      const app = harness.makeApp(undefined, {
        resolveBinaryArtifactStore: () => Promise.resolve(store),
      })
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const { workspace: other } = await app.createOrgWorkspace({ seed: true })
      const auth = await mintKey(app, workspace.id, 'read')
      store.seed(
        {
          id: 'art_foreign',
          workspaceId: other.id,
          executionId: 'exec_other',
          blockId: null,
          kind: 'screenshot',
          view: null,
          contentType: 'image/png',
          byteSize: 1,
          hash: 'ff',
          storage: 'memory',
          storageKey: 'art_foreign',
          createdAt: 1,
        },
        new Uint8Array([1]),
      )

      // The key's workspace is the boundary, and a flat artifact path is no wider than a nested
      // one because the row itself is re-scoped.
      const foreign = await app.callBinary('GET', '/api/v1/artifacts/art_foreign/blob', auth)
      expect(foreign.status).toBe(404)

      // A mistyped (or out-of-scope) run id must not read as "this run captured nothing".
      const missingRun = await app.call('GET', '/api/v1/runs/exec_nope/artifacts', undefined, auth)
      expect(missingRun.status).toBe(404)
    })

    it('refuses the artifact reads when the account configured no blob backend', async () => {
      const app = harness.makeApp(undefined, {
        resolveBinaryArtifactStore: () => Promise.resolve(null),
      })
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const auth = await mintKey(app, wsId, 'read')
      const runId = await startRun(app, wsId)

      // 503, never an empty list: "this deployment stores no artifacts" and "this run captured
      // none" are different facts, and only one of them is about the run.
      const listed = await app.call<{ error: { code: string } }>(
        'GET',
        `/api/v1/runs/${runId}/artifacts`,
        undefined,
        auth,
      )
      expect(listed.status).toBe(503)
      expect(listed.body.error.code).toBe('unavailable')
    })
  })
}

/** `/api/v1/keys`: the mint bounds, the revocation cascade, and the identity a key carries. */
function defineKeyProvisioningCases(harness: ConformanceHarness): void {
  describe('public API: headless key provisioning', () => {
    it('mints a working key, refuses the admin rung, and holds the scope gate', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const adminAuth = await mintKey(app, wsId, 'admin')

      // A `decide` key is one rung below the gate and must not be able to provision at all.
      const decideAuth = await mintKey(app, wsId, 'decide')
      const refused = await app.call<{ error: { code: string } }>(
        'POST',
        '/api/v1/keys',
        { label: 'escalation' },
        decideAuth,
      )
      expect(refused.status).toBe(403)
      expect(refused.body.error.code).toBe('insufficient_scope')

      // `admin` is not mintable over the API: a provisioned key can never provision in turn, so
      // the chain stays one link long. Refused by the contract's own picklist, so the request never
      // reaches the handler, which is exactly why there is no hand-written second copy of the rule
      // for the two to drift apart on.
      const escalating = await app.call<{ error: { code: string } }>(
        'POST',
        '/api/v1/keys',
        { label: 'second admin', scope: 'admin' },
        adminAuth,
      )
      expect(escalating.status).toBe(400)
      expect(escalating.body.error.code).toBe('validation')

      const minted = await app.call<{ key: PublicApiKey; secret: string }>(
        'POST',
        '/api/v1/keys',
        { label: 'per-tenant reader', scope: 'read' },
        adminAuth,
      )
      expect(minted.status).toBe(201)
      expect(minted.body.key.workspaceId).toBe(wsId)
      expect(minted.body.key.scope).toBe('read')
      // Attributed to the KEY that minted it, and to no user: a headless mint has no person
      // behind it, and naming the parent key's minter would be a guess dressed as provenance.
      expect(minted.body.key.createdByKeyId).toBeTruthy()
      expect(minted.body.key.createdByUserId).toBeNull()

      // The minted secret actually authenticates, at the scope it was minted with.
      const mintedAuth = { authorization: `Bearer ${minted.body.secret}` }
      const asRead = await app.call('GET', '/api/v1/services', undefined, mintedAuth)
      expect(asRead.status).toBe(200)
      const beyondScope = await app.call('GET', '/api/v1/keys', undefined, mintedAuth)
      expect(beyondScope.status).toBe(403)
    })

    it('revokes the keys a revoked key minted, on both stores', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const provisionerSecret = await app.call<{ key: PublicApiKey; secret: string }>(
        'POST',
        `/workspaces/${wsId}/public-api-keys`,
        { label: 'provisioner', scope: 'admin' },
      )
      expect(provisionerSecret.status).toBe(201)
      const provisioner = { authorization: `Bearer ${provisionerSecret.body.secret}` }

      const child = await app.call<{ key: PublicApiKey; secret: string }>(
        'POST',
        '/api/v1/keys',
        { label: 'child', scope: 'read' },
        provisioner,
      )
      expect(child.status).toBe(201)
      const childAuth = { authorization: `Bearer ${child.body.secret}` }
      expect((await app.call('GET', '/api/v1/services', undefined, childAuth)).status).toBe(200)

      // Revoking the minter through the SESSION surface (an operator killing a leaked credential
      // in the app) must take its offspring with it: the cascade is the reason provisioning is
      // safe to offer, and it has to hold in the real SQL of both stores.
      const revoked = await app.call(
        'DELETE',
        `/workspaces/${wsId}/public-api-keys/${provisionerSecret.body.key.id}`,
      )
      expect(revoked.status).toBe(204)
      expect((await app.call('GET', '/api/v1/services', undefined, provisioner)).status).toBe(401)
      expect((await app.call('GET', '/api/v1/services', undefined, childAuth)).status).toBe(401)
    })

    it('lists and revokes a provisioned key through the key alone', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const adminAuth = await mintKey(app, wsId, 'admin')
      const minted = await app.call<{ key: PublicApiKey; secret: string }>(
        'POST',
        '/api/v1/keys',
        { label: 'scratch' },
        adminAuth,
      )
      expect(minted.status).toBe(201)

      const listed = await app.call<{ keys: PublicApiKey[] }>(
        'GET',
        '/api/v1/keys',
        undefined,
        adminAuth,
      )
      expect(listed.status).toBe(200)
      expect(listed.body.keys.map((k) => k.id)).toContain(minted.body.key.id)
      // A secret is never readable back, on any surface.
      expect(JSON.stringify(listed.body)).not.toContain('cf_live_')

      // The provisioner retiring what it handed out. A provisioned key cannot do this itself:
      // revoking needs `admin`, which is precisely the rung this surface refuses to mint.
      const scratchAuth = { authorization: `Bearer ${minted.body.secret}` }
      expect((await app.call('DELETE', '/api/v1/keys/pak_x', undefined, scratchAuth)).status).toBe(
        403,
      )
      const revoked = await app.call(
        'DELETE',
        `/api/v1/keys/${minted.body.key.id}`,
        undefined,
        adminAuth,
      )
      expect(revoked.status).toBe(204)
      expect((await app.call('GET', '/api/v1/services', undefined, scratchAuth)).status).toBe(401)

      // Idempotent, and not an oracle: revoking an id that does not exist answers the same 204.
      const again = await app.call(
        'DELETE',
        `/api/v1/keys/${minted.body.key.id}`,
        undefined,
        adminAuth,
      )
      expect(again.status).toBe(204)
      const never = await app.call('DELETE', '/api/v1/keys/pak_nope', undefined, adminAuth)
      expect(never.status).toBe(204)
    })

    it('lets a provisioner revoke ITSELF, taking the keys it minted with it', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      // An app-minted `admin` key: the only kind that can name itself here, since revoking needs
      // the rung this surface will not mint.
      const provisioner = await app.call<{ key: PublicApiKey; secret: string }>(
        'POST',
        `/workspaces/${wsId}/public-api-keys`,
        { label: 'provisioner', scope: 'admin' },
      )
      expect(provisioner.status).toBe(201)
      const auth = { authorization: `Bearer ${provisioner.body.secret}` }

      const child = await app.call<{ key: PublicApiKey; secret: string }>(
        'POST',
        '/api/v1/keys',
        { label: 'child', scope: 'read' },
        auth,
      )
      expect(child.status).toBe(201)
      const childAuth = { authorization: `Bearer ${child.body.secret}` }

      // Naming its own id. The request is authorized before the write, so this settles rather
      // than 401-ing on the credential it is in the middle of destroying.
      const selfRevoke = await app.call(
        'DELETE',
        `/api/v1/keys/${provisioner.body.key.id}`,
        undefined,
        auth,
      )
      expect(selfRevoke.status).toBe(204)

      // Both are dead: the cascade does not care which door the revocation came through, which is
      // the whole point: an operator killing a compromised credential wants its offspring gone
      // whether they reach for the app or the API.
      expect((await app.call('GET', '/api/v1/services', undefined, auth)).status).toBe(401)
      expect((await app.call('GET', '/api/v1/services', undefined, childAuth)).status).toBe(401)
    })

    it('carries a provisioned key external identity onto the runs it starts, past revocation', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const adminAuth = await mintKey(app, wsId, 'admin')

      const minted = await app.call<{ key: PublicApiKey; secret: string }>(
        'POST',
        '/api/v1/keys',
        { label: 'for ada', scope: 'write', externalIdentity: IDENTITY },
        adminAuth,
      )
      expect(minted.status).toBe(201)
      // Echoed on the resource, and on the LIST, which is the read that goes back through the
      // store: a facade whose row mapping dropped the column answers `null` here.
      expect(minted.body.key.externalIdentity).toBe(IDENTITY)
      const listed = await app.call<{ keys: PublicApiKey[] }>(
        'GET',
        '/api/v1/keys',
        undefined,
        adminAuth,
      )
      const stored = listed.body.keys.find((k) => k.id === minted.body.key.id)
      expect(stored?.externalIdentity).toBe(IDENTITY)

      // And on `/me`, which is how a subsystem handed the credential discovers who it runs as.
      const perUserAuth = { authorization: `Bearer ${minted.body.secret}` }
      const me = await app.call<{ externalIdentity: string | null }>(
        'GET',
        '/api/v1/me',
        undefined,
        perUserAuth,
      )
      expect(me.status).toBe(200)
      expect(me.body.externalIdentity).toBe(IDENTITY)

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const started = await app.call(
        'POST',
        '/api/v1/tasks/task_login/start',
        { pipelineId: pipeline.body.id },
        perUserAuth,
      )
      expect(started.status).toBe(202)

      const run = await app.call<{ externalIdentity: string | null }>(
        'GET',
        '/api/v1/tasks/task_login/run',
        undefined,
        adminAuth,
      )
      expect(run.status).toBe(200)
      // The identity rides `agent_runs.detail` through each facade's real store, like the intake
      // origin beside it: a facade with its own execution mapping drops it here rather than in
      // production, where it would read as a run nobody started.
      expect(run.body.externalIdentity).toBe(IDENTITY)

      // The property the PIN exists for, and the one no unit test can stage: revoking the key
      // (what an integration does the day the person leaves) must not erase who the finished run
      // was for. A read that resolved the identity from the key would answer `null` from here on.
      expect(
        (await app.call('DELETE', `/api/v1/keys/${minted.body.key.id}`, undefined, adminAuth))
          .status,
      ).toBe(204)
      const afterRevoke = await app.call<{ externalIdentity: string | null }>(
        'GET',
        '/api/v1/tasks/task_login/run',
        undefined,
        adminAuth,
      )
      expect(afterRevoke.body.externalIdentity).toBe(IDENTITY)
    })

    it('leaves the identity null for a key minted without one', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const adminAuth = await mintKey(app, wsId, 'admin')
      const minted = await app.call<{ key: PublicApiKey; secret: string }>(
        'POST',
        '/api/v1/keys',
        { label: 'plain' },
        adminAuth,
      )
      expect(minted.status).toBe(201)
      // NOT inherited from the provisioning key (which has none either, but would be the obvious
      // wrong default): a provisioner mints for many identities, so attributing its own would
      // name the integration on every run it ever starts for anyone.
      expect(minted.body.key.externalIdentity).toBeNull()

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const started = await app.call(
        'POST',
        '/api/v1/tasks/task_login/start',
        { pipelineId: pipeline.body.id },
        { authorization: `Bearer ${minted.body.secret}` },
      )
      expect(started.status).toBe(202)
      const run = await app.call<{ externalIdentity: string | null }>(
        'GET',
        '/api/v1/tasks/task_login/run',
        undefined,
        adminAuth,
      )
      expect(run.body.externalIdentity).toBeNull()
    })
  })
}
