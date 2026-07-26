import { describe, expect, it, vi } from 'vitest'
import type {
  EnvironmentHandlerView,
  RegisterHandlerInput,
} from './EnvironmentConnectionService.js'
import { createEnvironmentHandlerSeeder } from './EnvironmentHandlerSeeder.js'

// The seeder only ever reads `provisionType` + `manifestId` off a listed handler and hands a seed
// straight to `registerHandler`, so the fakes below carry just those fields (cast to the full view
// / input shapes) — the point of these tests is the idempotency + per-seed fault isolation logic,
// not the connection service's own registration behaviour (covered by its own suite).

function view(provisionType: string, manifestId: string | null): EnvironmentHandlerView {
  return { provisionType, manifestId } as unknown as EnvironmentHandlerView
}

function seed(provisionType: string, manifestId?: string | null): RegisterHandlerInput {
  return {
    provisionType,
    ...(manifestId !== undefined ? { manifestId } : {}),
    config: {},
    secrets: {},
  } as unknown as RegisterHandlerInput
}

/** A connection service whose `registerHandler` reflects each registration back into the handler
 *  list, so a second `ensureForWorkspace` re-reads it and correctly skips (the idempotency path). */
function fakeConnectionService(initial: EnvironmentHandlerView[] = []) {
  const handlers = [...initial]
  return {
    handlers,
    listHandlers: vi.fn((_workspaceId: string) => Promise.resolve(handlers)),
    registerHandler: vi.fn((_workspaceId: string, input: RegisterHandlerInput) => {
      const v = view(input.provisionType, input.manifestId ?? null)
      handlers.push(v)
      return Promise.resolve(v)
    }),
  }
}

describe('createEnvironmentHandlerSeeder', () => {
  it('registers a declared seed that is not already present', async () => {
    const cs = fakeConnectionService()
    const seeder = createEnvironmentHandlerSeeder({
      connectionService: cs,
      seeds: [seed('kubernetes')],
    })

    await seeder.ensureForWorkspace('ws-1')

    expect(cs.registerHandler).toHaveBeenCalledTimes(1)
    expect(cs.registerHandler).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ provisionType: 'kubernetes' }),
    )
  })

  it('skips a seed already present (matched by provisionType + manifestId)', async () => {
    // (custom, m1) is already registered; (custom, m2) is a distinct handler that must be seeded.
    const cs = fakeConnectionService([view('custom', 'm1')])
    const seeder = createEnvironmentHandlerSeeder({
      connectionService: cs,
      seeds: [seed('custom', 'm1'), seed('custom', 'm2')],
    })

    await seeder.ensureForWorkspace('ws-1')

    expect(cs.registerHandler).toHaveBeenCalledTimes(1)
    expect(cs.registerHandler).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ provisionType: 'custom', manifestId: 'm2' }),
    )
  })

  it('swallows a failing seed (warned) and still registers the others', async () => {
    const cs = fakeConnectionService()
    cs.registerHandler.mockImplementation((_workspaceId: string, input: RegisterHandlerInput) => {
      if (input.provisionType === 'docker-compose') {
        return Promise.reject(new Error('invalid handler config'))
      }
      return Promise.resolve(view(input.provisionType, input.manifestId ?? null))
    })
    const warn = vi.fn()
    const seeder = createEnvironmentHandlerSeeder({
      connectionService: cs,
      // The bad seed is FIRST, so we also prove it doesn't abort the ones after it.
      seeds: [seed('docker-compose'), seed('kubernetes')],
      logger: { info: vi.fn(), warn },
    })

    await expect(seeder.ensureForWorkspace('ws-1')).resolves.toBeUndefined()

    expect(cs.registerHandler).toHaveBeenCalledTimes(2)
    expect(cs.registerHandler).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ provisionType: 'kubernetes' }),
    )
    // The swallowed failure is surfaced (warn), not silent, and only for the one bad seed.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'ws-1',
      provisionType: 'docker-compose',
    })
  })

  it('is idempotent — a second run registers nothing new', async () => {
    const cs = fakeConnectionService()
    const seeder = createEnvironmentHandlerSeeder({
      connectionService: cs,
      seeds: [seed('kubernetes'), seed('custom', 'm1')],
    })

    await seeder.ensureForWorkspace('ws-1')
    expect(cs.registerHandler).toHaveBeenCalledTimes(2)

    cs.registerHandler.mockClear()
    await seeder.ensureForWorkspace('ws-1')
    expect(cs.registerHandler).not.toHaveBeenCalled()
  })

  it('is a no-op when no seeds are declared (never even reads the handlers)', async () => {
    const cs = fakeConnectionService()
    const seeder = createEnvironmentHandlerSeeder({ connectionService: cs, seeds: [] })

    await seeder.ensureForWorkspace('ws-1')

    expect(cs.listHandlers).not.toHaveBeenCalled()
    expect(cs.registerHandler).not.toHaveBeenCalled()
  })
})
