import { describe, expect, it, vi } from 'vitest'
import { createBackendRegistries } from '@cat-factory/integrations'
import {
  createRecordingLogger,
  type RunnerPoolConnectionRecord,
  type RunnerPoolConnectionRepository,
} from '@cat-factory/kernel'
import type { CoreRepositories, NodeContainerOptions } from '@cat-factory/node-server'
import type { WorkspaceSettingsService } from '@cat-factory/orchestration'
import type { AppConfig } from '@cat-factory/server'
import type { MothershipComposition } from './mothership.js'
import { buildLocalRunnerPoolBackend, localRunnerPoolSeed } from './runnerPoolBackend.js'

// A node in mothership mode opens pool secrets with its own key, and account pools are sealed on
// the mothership. So the node never seeds the account tier and never reads it: a delegating board
// there needs a pool registered on the board itself, and a refusal says so.

const SEED = () => undefined

const ownRow = (kind: string): RunnerPoolConnectionRecord => ({
  workspaceId: 'ws_1',
  kind,
  providerId: kind,
  label: 'Board pool',
  baseUrl: 'https://k8s.example:6443',
  configJson: '{}',
  secretsCipher: '',
  createdAt: 1,
  deletedAt: null,
})

function mothershipNode(own: RunnerPoolConnectionRecord | null) {
  const accountOf = vi.fn(async () => 'acc_1')
  const mothership = {
    repos: {
      runnerPoolConnectionRepository: {
        getByWorkspace: async () => own,
      } as unknown as RunnerPoolConnectionRepository,
    },
  } as unknown as MothershipComposition
  const backend = buildLocalRunnerPoolBackend({
    options: {} as NodeContainerOptions,
    mothership,
    repos: { workspaceRepository: { accountOf } } as unknown as CoreRepositories,
    wsSettings: {
      get: async () => ({ delegateAgentsToRunnerPool: true }),
    } as unknown as WorkspaceSettingsService,
    config: {
      runners: { enabled: true, encryptionKey: Buffer.alloc(32).toString('base64') },
    } as unknown as AppConfig,
    clock: { now: () => 1 },
    runnerBackendRegistry: createBackendRegistries().runnerBackendRegistry,
  })
  return { backend, accountOf }
}

async function refusalOf(run: Promise<void>) {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught as { details?: Record<string, unknown>; message: string },
  )
  expect(error).not.toBeNull()
  return error!
}

describe('localRunnerPoolSeed', () => {
  it('passes the seed through on the Postgres path', () => {
    const log = createRecordingLogger()

    expect(localRunnerPoolSeed({ seedAccountRunnerPool: SEED }, undefined, log)).toBe(SEED)
    expect(log.lines).toEqual([])
  })

  it('drops the seed in mothership mode and warns once, naming why', () => {
    const log = createRecordingLogger()
    const mothership = {} as MothershipComposition

    expect(localRunnerPoolSeed({ seedAccountRunnerPool: SEED }, mothership, log)).toBeUndefined()
    expect(log.lines).toHaveLength(1)
    expect(log.lines[0]).toMatchObject({ level: 'warn' })
    expect(log.lines[0]!.msg).toContain('sealed on the mothership')
  })

  it('says nothing in mothership mode when no seed was declared', () => {
    const log = createRecordingLogger()

    expect(localRunnerPoolSeed({}, {} as MothershipComposition, log)).toBeUndefined()
    expect(log.lines).toEqual([])
  })
})

describe('local runner-pool start guard on a mothership node', () => {
  it('refuses a board with no pool of its own without reading the account tier', async () => {
    const { backend, accountOf } = mothershipNode(null)

    const error = await refusalOf(backend.assertAgentBackendConfigured('ws_1'))

    expect(error.details).toMatchObject({
      reason: 'agent_backend_unconfigured',
      runnerPool: 'none',
    })
    expect(error.message).toContain('does not reach a node in mothership mode')
    expect(accountOf).not.toHaveBeenCalled()
  })

  it('refuses a pool whose backend kind is not registered, naming the kind', async () => {
    const { backend } = mothershipNode(ownRow('nomad'))

    const error = await refusalOf(backend.assertAgentBackendConfigured('ws_1'))

    expect(error.details).toMatchObject({ runnerPool: 'unknown_kind', kind: 'nomad' })
  })

  it('admits a board whose own pool has a registered kind', async () => {
    const { backend } = mothershipNode(ownRow('kubernetes'))

    await expect(backend.assertAgentBackendConfigured('ws_1')).resolves.toBeUndefined()
  })
})
