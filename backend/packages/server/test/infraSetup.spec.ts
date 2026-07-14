import { describe, expect, it } from 'vitest'
import {
  areaStatus,
  type InfraSetupSources,
  snapshotInfraSetup,
} from '../src/modules/workspaces/WorkspaceController.js'

// Unit coverage for the infra-setup snapshot projection. The cross-runtime conformance suite only
// pins "present + valid enum" (per-area values legitimately differ by runtime); these tests pin the
// actual detection: wired-but-unconfigured → `not_defined`, configured → `configured`, unwired →
// `not_applicable`, that the agent-executor area only fires where a runner pool is the SOLE executor
// (`agentExecutorRequiresRunnerPool`) and the ephemeral-environments area only where a provider is
// genuinely mandatory (`ephemeralEnvironmentsRequireProvider` — local docker-compose needs none),
// and the fault-isolation that a throwing/hanging probe degrades
// to `not_applicable` (logged) rather than 500-ing / stalling the board load.

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

  it('degrades to not_applicable when the read hangs past the timeout (never stalls the board)', async () => {
    const status = await areaStatus(true, () => new Promise<boolean>(() => {}), { timeoutMs: 10 })
    expect(status).toBe('not_applicable')
  })

  it('logs the swallowed fault so a persistent misconfig stays diagnosable', async () => {
    const warns: Array<Record<string, unknown>> = []
    const logger = { warn: (obj: Record<string, unknown>) => warns.push(obj) }
    await areaStatus(
      true,
      async () => {
        throw new Error('boom')
      },
      { area: 'agentExecutor', logger },
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ area: 'agentExecutor', err: 'boom' })
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
        agentExecutorRequiresRunnerPool: true, // stock/remote Node: the pool is the only executor
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

  it('ephemeralEnvironments is not_defined when a provider is required and none is registered (Worker / stock Node)', async () => {
    const infra = await snapshotInfraSetup(
      { environments: envSource(false), ephemeralEnvironmentsRequireProvider: true },
      WS,
    )
    expect(infra.ephemeralEnvironments).toBe('not_defined')
  })

  it('ephemeralEnvironments is not_applicable when a zero-config default exists, even with no provider (local docker-compose)', async () => {
    // Local mode on a Docker-family runtime stands the Tester's deps up with `local-compose` (no
    // connection), so a missing provider must NOT nag — the `ephemeralEnvironmentsRequireProvider`
    // gate keeps this `not_applicable` rather than the false-positive `not_defined`, mirroring the
    // agent-executor gate above. The env probe is never even called.
    let called = false
    const infra = await snapshotInfraSetup(
      {
        environments: {
          connectionService: {
            hasConnection: async () => {
              called = true
              return false
            },
          },
        },
        ephemeralEnvironmentsRequireProvider: false,
      },
      WS,
    )
    expect(infra.ephemeralEnvironments).toBe('not_applicable')
    expect(called).toBe(false)
  })

  it('ephemeralEnvironments defaults to required when the gate is unset (preserves hosted-facade nag)', async () => {
    const infra = await snapshotInfraSetup({ environments: envSource(false) }, WS)
    expect(infra.ephemeralEnvironments).toBe('not_defined')
  })

  it('agentExecutor is not_defined when the pool is the sole executor and none is registered (remote Node)', async () => {
    const infra = await snapshotInfraSetup(
      { runners: runnerSource(false), agentExecutorRequiresRunnerPool: true },
      WS,
    )
    expect(infra.agentExecutor).toBe('not_defined')
  })

  it('agentExecutor is not_applicable when the runner surface is wired but NOT the sole executor (local / Cloudflare)', async () => {
    // Local mode always wires the runner surface (ENCRYPTION_KEY is always set) yet runs agents in
    // per-run host containers, so a missing pool must NOT nag — the flag gates that.
    const unregistered = await snapshotInfraSetup({ runners: runnerSource(false) }, WS)
    expect(unregistered.agentExecutor).toBe('not_applicable')
    // Even a *registered* pool is not_applicable there: the pool isn't the executor of record.
    const registered = await snapshotInfraSetup({ runners: runnerSource(true) }, WS)
    expect(registered.agentExecutor).toBe('not_applicable')
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
        agentExecutorRequiresRunnerPool: true,
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
        agentExecutorRequiresRunnerPool: true,
        resolveBinaryArtifactStore: async (ws) => (seen.push(ws), {}),
      },
      WS,
    )
    expect(seen).toEqual([WS, WS, WS])
  })
})
