import type {
  ConnectionTestResult,
  RunnerBackendConfig,
  RunnerPoolConnectionRecord,
  RunnerPoolConnectionRepository,
  RunnerPoolManifest,
  RunnerPoolProvider,
  SecretCipher,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { RunnerPoolConnectionService } from './RunnerPoolConnectionService.js'
import { defaultRunnerBackendRegistry } from './runner-backends.js'

// A manifest gap (no `release` template, no status path) costs a cleanup or recovery path that
// stays invisible until an incident, so it has to reach a human at the moment it is made. It
// reaches TWO: the deployment log (whoever operates the install) at registration, and the
// connection test (whoever pasted the config) as structured warnings. These pin both, because
// each is silent in a different way when it breaks.

const MANIFEST: RunnerPoolManifest = {
  providerId: 'acme-pool',
  label: 'Acme',
  baseUrl: 'https://pool.test/api',
  auth: { type: 'none' },
  dispatch: { method: 'POST', pathTemplate: '/jobs' },
  poll: { method: 'GET', pathTemplate: '/jobs/{{input.jobId}}' },
  release: { method: 'DELETE', pathTemplate: '/jobs/{{input.jobId}}' },
  response: { statusPath: 'state' },
}

/** A manifest missing its release template — valid, connectable, and quietly leaky. */
const withoutRelease = (): RunnerPoolManifest => {
  const { release: _release, ...rest } = MANIFEST
  return rest as RunnerPoolManifest
}

function makeService(logger = createRecordingLogger()) {
  let stored: RunnerPoolConnectionRecord | null = null
  const runnerPoolConnectionRepository = {
    getByWorkspace: async () => stored,
    upsert: async (record: RunnerPoolConnectionRecord) => {
      stored = record
    },
  } as unknown as RunnerPoolConnectionRepository
  // The probe itself is not under test (it would reach the network), so the injected provider
  // answers it; what matters is that the warnings ride ALONGSIDE whatever it reports.
  const runnerPoolProvider = {
    testConnection: async (): Promise<ConnectionTestResult> => ({ ok: true, message: 'probe ok' }),
  } as unknown as RunnerPoolProvider
  const service = new RunnerPoolConnectionService({
    runnerPoolConnectionRepository,
    workspaceRepository: { get: async () => ({ id: 'ws_1' }) } as unknown as WorkspaceRepository,
    secretCipher: {
      encrypt: async (v: string) => v,
      decrypt: async (v: string) => v,
    } as SecretCipher,
    clock: { now: () => 1_000 },
    runnerBackendRegistry: defaultRunnerBackendRegistry(),
    runnerPoolProvider,
    logger,
  })
  return { service, logger }
}

const manifestConfig = (manifest: RunnerPoolManifest): RunnerBackendConfig =>
  ({ kind: 'manifest', manifest }) as RunnerBackendConfig

describe('RunnerPoolConnectionService gap warnings', () => {
  it('returns the config gaps on the connection test, beside a PASSING probe', async () => {
    // Independent of `ok`: a release-less manifest connects perfectly well and still leaks a
    // runner on every cancelled run, so a green test must not read as "nothing to fix".
    const { service } = makeService()
    const result = await service.testConnection('ws_1', {
      config: manifestConfig(withoutRelease()),
      secrets: {},
    })
    expect(result.ok).toBe(true)
    expect(result.message).toBe('probe ok')
    expect(result.warnings?.map((w) => w.code)).toEqual(['runner_manifest_no_release'])
    // The code is what the SPA renders from; the message is the untranslated last resort.
    expect(result.warnings?.[0]?.message).toContain('no release template')
  })

  it('omits `warnings` entirely for a complete manifest', async () => {
    const { service } = makeService()
    const result = await service.testConnection('ws_1', {
      config: manifestConfig(MANIFEST),
      secrets: {},
    })
    expect(result.warnings).toBeUndefined()
  })

  it('logs each gap once at registration, with its code bound as a field', async () => {
    // Registration is the operator's action, so the log line is emitted there and NOT per
    // dispatch, where `resolve()` would repeat it for every job.
    const { service, logger } = makeService()
    await service.register('ws_1', {
      config: manifestConfig({ ...withoutRelease(), response: {} }),
      secrets: {},
    })
    const warnings = logger.lines.filter((l) => l.level === 'warn')
    expect(warnings.map((l) => l.fields?.warning)).toEqual([
      'runner_manifest_no_release',
      'runner_manifest_no_status_path',
    ])
    expect(warnings[0]?.fields).toMatchObject({ workspaceId: 'ws_1', kind: 'manifest' })
  })

  it('logs nothing for a complete manifest', async () => {
    const { service, logger } = makeService()
    await service.register('ws_1', { config: manifestConfig(MANIFEST), secrets: {} })
    expect(logger.lines.filter((l) => l.level === 'warn')).toEqual([])
  })
})
