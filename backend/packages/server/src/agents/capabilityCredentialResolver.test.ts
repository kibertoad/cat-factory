import type { ToolSecretResolver } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  buildToolSecretChain,
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

// `buildToolSecretChain` is the ONE composition site every facade calls. What these pin is that
// the description it returns beside the resolver is derived from what it actually composed: the
// credential checklist renders that flag, and the two answers send an operator in opposite
// directions (hunt for a value that already resolves, or leave a blank row that never will).
describe('the composed capability-credential chain', () => {
  const credentials = {
    resolveValues: async () => [{ key: 'VENDOR_KEY', value: 'tenant' }],
  } as never

  it('puts the store in front of the environment, and says the fallback is there', async () => {
    const chain = buildToolSecretChain({
      credentials,
      env: { VENDOR_KEY: 'deployment', OTHER_KEY: 'shared' },
    })
    expect(chain.environmentFallback).toBe(true)
    expect(await ask(chain.resolver, 'ws_a', ['VENDOR_KEY', 'OTHER_KEY'])).toEqual({
      VENDOR_KEY: 'tenant',
      OTHER_KEY: 'shared',
    })
  })

  it('drops the environment when a deployment declares the chain store-ONLY', async () => {
    // The multi-tenant shape: an unstored key must resolve to NOTHING rather than to whoever set
    // the deployment's variable, and the checklist must stop calling a blank row "may still work".
    const chain = buildToolSecretChain({
      credentials,
      env: { VENDOR_KEY: 'deployment', OTHER_KEY: 'shared' },
      environmentFallback: false,
    })
    expect(chain.environmentFallback).toBe(false)
    expect(await ask(chain.resolver, 'ws_a', ['VENDOR_KEY', 'OTHER_KEY'])).toEqual({
      VENDOR_KEY: 'tenant',
    })
  })

  it('describes a deployment’s OWN resolver as unknown rather than guessing', async () => {
    // It replaced the chain, and it may read Vault, the environment, or both. Either boolean is a
    // claim the platform cannot make, so the third state is the honest one.
    const own: ToolSecretResolver = { resolve: async () => ({ VENDOR_KEY: 'vault' }) }
    const chain = buildToolSecretChain({ custom: own, credentials, env: { VENDOR_KEY: 'dep' } })
    expect(chain.environmentFallback).toBeUndefined()
    expect(chain.resolver).toBe(own)
  })

  it('refuses LOUDLY when store-only was declared and there is no store', async () => {
    // Nothing can resolve, and the run-path symptom names the capability rather than the
    // deployment's own configuration — so the composition is where it gets said.
    const logger = createRecordingLogger()
    const chain = buildToolSecretChain({
      env: { VENDOR_KEY: 'deployment' },
      environmentFallback: false,
      logger,
    })
    expect(await ask(chain.resolver, 'ws_a', ['VENDOR_KEY'])).toEqual({})
    expect(logger.lines.filter((line) => line.level === 'error')).toHaveLength(1)
  })
})
