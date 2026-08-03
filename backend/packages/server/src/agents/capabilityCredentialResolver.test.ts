import type { ToolSecretResolver } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  composeToolSecretResolvers,
  createWorkspaceToolSecretResolver,
} from './capabilityCredentialResolver.js'
import { createEnvToolSecretResolver } from './toolServers.js'

// The per-workspace credential store in front of the deployment environment. What these pin is the
// property the whole change rests on: a TENANT's own value wins, and a workspace that stored
// nothing resolves exactly as it did before the store existed.

const store = (values: Record<string, Record<string, string>>) =>
  createWorkspaceToolSecretResolver({
    credentials: {
      resolveValues: async (workspaceId: string) =>
        Object.entries(values[workspaceId] ?? {}).map(([key, value]) => ({ key, value })),
    } as never,
  })

const ask = (resolver: ToolSecretResolver, workspaceId: string, keys: string[]) =>
  resolver.resolve({
    workspaceId,
    subject: { kind: 'tool-server', id: 'issues' },
    keys: keys.map((key) => ({ key })),
  })

describe('createWorkspaceToolSecretResolver', () => {
  it('answers only for keys THIS workspace stored', async () => {
    const resolver = store({ ws_a: { VENDOR_KEY: 'a-secret' }, ws_b: { VENDOR_KEY: 'b-secret' } })
    expect(await ask(resolver, 'ws_a', ['VENDOR_KEY'])).toEqual({ VENDOR_KEY: 'a-secret' })
    expect(await ask(resolver, 'ws_b', ['VENDOR_KEY'])).toEqual({ VENDOR_KEY: 'b-secret' })
    expect(await ask(resolver, 'ws_c', ['VENDOR_KEY'])).toEqual({})
  })

  it('omits a key it holds nothing for, rather than answering empty-string', async () => {
    // The port's contract IS the composition rule: absent means "ask the next one".
    const resolver = store({ ws_a: { VENDOR_KEY: 'a-secret' } })
    expect(await ask(resolver, 'ws_a', ['VENDOR_KEY', 'OTHER_KEY'])).toEqual({
      VENDOR_KEY: 'a-secret',
    })
  })
})

describe('composeToolSecretResolvers', () => {
  const env = createEnvToolSecretResolver({ VENDOR_KEY: 'deployment', OTHER_KEY: 'shared' })

  it('lets a workspace value WIN over the deployment environment', async () => {
    const composed = composeToolSecretResolvers([store({ ws_a: { VENDOR_KEY: 'tenant' } }), env])
    expect(await ask(composed, 'ws_a', ['VENDOR_KEY'])).toEqual({ VENDOR_KEY: 'tenant' })
  })

  it('falls through to the environment for a workspace that stored nothing', async () => {
    // The reason the env resolver is kept: a local install and a single-tenant deployment need no
    // migration and no UI visit.
    const composed = composeToolSecretResolvers([store({}), env])
    expect(await ask(composed, 'ws_a', ['VENDOR_KEY'])).toEqual({ VENDOR_KEY: 'deployment' })
  })

  it('resolves PER KEY, so a partially-filled workspace does not lose the rest', async () => {
    // The bug the per-key rule exists to prevent: "first resolver that returns anything wins"
    // would silently turn off every integration whose key the operator had not typed in yet.
    const composed = composeToolSecretResolvers([store({ ws_a: { VENDOR_KEY: 'tenant' } }), env])
    expect(await ask(composed, 'ws_a', ['VENDOR_KEY', 'OTHER_KEY'])).toEqual({
      VENDOR_KEY: 'tenant',
      OTHER_KEY: 'shared',
    })
  })

  it('degrades to the fallback when the store THROWS, and says so', async () => {
    // A store outage must cost the tenant override, never every dispatch — the same disposition
    // the two call sites already apply to an unresolved key.
    const broken: ToolSecretResolver = {
      resolve: async () => {
        throw new Error('database unreachable')
      },
    }
    const logger = createRecordingLogger()
    const composed = composeToolSecretResolvers([broken, env], logger)
    expect(await ask(composed, 'ws_a', ['VENDOR_KEY'])).toEqual({ VENDOR_KEY: 'deployment' })
    expect(logger.lines.filter((line) => line.level === 'warn')).toHaveLength(1)
  })

  it('stops asking once every key is answered', async () => {
    let asked = 0
    const counted: ToolSecretResolver = {
      resolve: async () => {
        asked += 1
        return {}
      },
    }
    const composed = composeToolSecretResolvers([
      store({ ws_a: { VENDOR_KEY: 'tenant' } }),
      counted,
    ])
    await ask(composed, 'ws_a', ['VENDOR_KEY'])
    expect(asked).toBe(0)
  })
})
