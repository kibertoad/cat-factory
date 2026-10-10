import type { PublicApiKeyService } from '@cat-factory/integrations'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { publicDiscoveryController } from '../src/modules/publicApi/PublicDiscoveryController.js'

// The two discovery reads, driven without a database.
//
// Both exist to remove a guess, so what is worth pinning is that they answer at the FLOOR of the
// scope ladder: a startup self-check gated above `read` is a check that itself needs a wider key,
// and a spec a caller has to hold an `admin` credential to read is a spec they will take from
// somewhere else instead.

const KEYS: Record<string, Awaited<ReturnType<PublicApiKeyService['authenticate']>>> = {
  'reader.secret': {
    keyId: 'pak_1',
    accountId: 'acc_1',
    workspaceId: 'ws_1',
    scope: 'read',
    label: 'CI pipeline',
    externalIdentity: null,
    actsAsUserId: null,
    createdByUserId: 'usr_1',
    createdAt: 1_700_000_000_000,
  },
  // A key a provisioner minted FOR someone: `/me` is how the subsystem holding it discovers which
  // identity it is running as, rather than being told twice by whoever handed it over.
  'per-user.secret': {
    keyId: 'pak_2',
    accountId: 'acc_1',
    workspaceId: 'ws_1',
    scope: 'read',
    label: 'os user',
    externalIdentity: 'os-user:42',
    actsAsUserId: null,
    // Provisioned headlessly through `POST /api/v1/keys`, so there is no minting person at all.
    createdByUserId: null,
    createdAt: 1_700_000_000_000,
  },
}

function build(options: { unconfigured?: boolean } = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const container = (
    options.unconfigured
      ? {}
      : {
          publicApiKeys: {
            authenticate: async (raw?: string) => (raw ? (KEYS[raw] ?? null) : null),
          } as unknown as PublicApiKeyService,
        }
  ) as ServerContainer
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.onError(handleError)
  app.route('/', publicDiscoveryController())
  return app
}

const withKey = (secret: string) => ({ headers: { authorization: `Bearer ${secret}` } })

describe('GET /api/v1/me', () => {
  it('describes the calling key for a read-scope caller', async () => {
    const res = await build().request('/api/v1/me', withKey('reader.secret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      keyId: 'pak_1',
      accountId: 'acc_1',
      workspaceId: 'ws_1',
      scope: 'read',
      label: 'CI pipeline',
      externalIdentity: null,
      createdAt: 1_700_000_000_000,
    })
  })

  it('names the identity a provisioned key acts for, when it has one', async () => {
    const res = await build().request('/api/v1/me', withKey('per-user.secret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ keyId: 'pak_2', externalIdentity: 'os-user:42' })
  })

  it('refuses an unknown key with the surface’s own 401, never a description of nobody', async () => {
    const res = await build().request('/api/v1/me', withKey('nope'))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } })
  })

  it('503s where the public API is not configured, like every other route here', async () => {
    const res = await build({ unconfigured: true }).request('/api/v1/me', withKey('reader.secret'))
    expect(res.status).toBe(503)
  })
})

describe('GET /api/v1/openapi.json', () => {
  it('serves the deployment’s own spec as JSON to a read-scope key', async () => {
    const res = await build().request('/api/v1/openapi.json', withKey('reader.secret'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
    expect(doc.openapi).toBe('3.1.0')
    // It describes THIS surface, which is the whole reason to serve it from the deployment rather
    // than let a caller find a copy of the repo file: an operator on an older build gets that
    // build's operations, not the ones main has since added.
    expect(doc.paths['/api/v1/me']).toBeDefined()
  })

  it('needs a key: the spec is the map of everything else here', async () => {
    const res = await build().request('/api/v1/openapi.json')
    expect(res.status).toBe(401)
  })
})
