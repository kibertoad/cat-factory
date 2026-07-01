import { describe, expect, it } from 'vitest'
import {
  areaStatus,
  type InfraSetupSources,
  snapshotInfraSetup,
} from '../src/modules/workspaces/WorkspaceController.js'

// Unit coverage for the infra-setup snapshot projection. The cross-runtime conformance suite only
// pins "present + valid enum" (per-area values legitimately differ by runtime); these tests pin the
// actual detection: wired-but-unconfigured → `not_defined`, configured → `configured`, unwired →
// `not_applicable`, and the fault-isolation that a throwing probe degrades to `not_applicable`
// rather than 500-ing the board load.

const WS = 'ws-1'

function envSource(has: boolean): InfraSetupSources['environments'] {
  return { connectionService: { hasConnection: async () => has } }
}
function runnerSource(has: boolean): InfraSetupSources['runners'] {
  return { connectionService: { hasConnection: async () => has } }
}

describe('areaStatus', () => {
  it('is not_applicable when the area is not wired (read never called)', async () => {
    let called = false
    const status = await areaStatus(false, async () => {
      called = true
      return true
    })
    expect(status).toBe('not_applicable')
    expect(called).toBe(false)
  })

  it('is configured when wired and the read is truthy', async () => {
    expect(await areaStatus(true, async () => ({}))).toBe('configured')
  })

  it('is not_defined when wired and the read is falsy', async () => {
    expect(await areaStatus(true, async () => null)).toBe('not_defined')
    expect(await areaStatus(true, async () => false)).toBe('not_defined')
  })

  it('degrades to not_applicable when the read throws (advisory: never break the snapshot)', async () => {
    const status = await areaStatus(true, async () => {
      throw new Error('rotated key / RPC does not expose the repo')
    })
    expect(status).toBe('not_applicable')
  })
})

describe('snapshotInfraSetup', () => {
  it('reports not_applicable for every area an unwired facade omits', async () => {
    const infra = await snapshotInfraSetup({}, WS)
    expect(infra).toEqual({
      ephemeralEnvironments: 'not_applicable',
      agentExecutor: 'not_applicable',
      binaryStorage: 'not_applicable',
    })
  })

  it('distinguishes configured from not_defined per area', async () => {
    const infra = await snapshotInfraSetup(
      {
        environments: envSource(false), // no env provider registered
        runners: runnerSource(true), // a runner pool is connected
        resolveBinaryArtifactStore: async () => null, // account picked no storage backend
      },
      WS,
    )
    expect(infra).toEqual({
      ephemeralEnvironments: 'not_defined',
      agentExecutor: 'configured',
      binaryStorage: 'not_defined',
    })
  })

  it('treats a resolved artifact store as configured', async () => {
    const infra = await snapshotInfraSetup(
      { resolveBinaryArtifactStore: async () => ({ put: () => {} }) },
      WS,
    )
    expect(infra.binaryStorage).toBe('configured')
  })

  it('fault-isolates a throwing probe to not_applicable without failing the others', async () => {
    const infra = await snapshotInfraSetup(
      {
        environments: {
          connectionService: {
            hasConnection: async () => {
              throw new Error('boom')
            },
          },
        },
        runners: runnerSource(true),
      },
      WS,
    )
    expect(infra.ephemeralEnvironments).toBe('not_applicable')
    expect(infra.agentExecutor).toBe('configured')
    expect(infra.binaryStorage).toBe('not_applicable')
  })

  it('passes the workspace id through to each probe', async () => {
    const seen: string[] = []
    await snapshotInfraSetup(
      {
        environments: { connectionService: { hasConnection: async (ws) => (seen.push(ws), true) } },
        runners: { connectionService: { hasConnection: async (ws) => (seen.push(ws), true) } },
        resolveBinaryArtifactStore: async (ws) => (seen.push(ws), {}),
      },
      WS,
    )
    expect(seen).toEqual([WS, WS, WS])
  })
})
