import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  ORG_SECRET_KEY_ARITY,
  ORG_SECRET_SOURCES,
  createOrgSecretCipher,
} from '@cat-factory/kernel'
import { HmacSigner, TOKEN_AUDIENCE } from '../src/auth/signing.js'
import { mintMachineToken } from '../src/auth/machineToken.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { secretDelegationController } from '../src/modules/persistence/SecretDelegationController.js'
import {
  SEALED_SECRET_SOURCES,
  sealedSecretSourceSpec,
} from '../src/secrets/sealedSecretSources.js'
import {
  HttpSecretDelegate,
  MachineSecretDelegationUnavailableError,
} from '../src/persistence/secretDelegation.js'

// The mothership-mode SECRET DELEGATION endpoints (`POST /internal/secrets/{unseal,seal}`): a
// machine-authed node asks the mothership to open (or seal) an ORG-owned credential it holds no
// key for. Verify the machine-token audience pin (missing / wrong audience / wrong secret), the
// workspace → account scope binding (uniform 404, no existence leak), that the opened value comes
// from the mothership's OWN row rather than anything the caller supplied, the closed source table
// (including prototype members), the declared key arity, the 503 on a facade with no cipher, and
// the client's throw-never-degrade contract.

const SECRET = 'test-session-secret-0123456789'
const ACCOUNT = 'acc_1'
const OTHER_ACCOUNT = 'acc_2'

const ACCOUNT_BY_WORKSPACE: Record<string, string> = { ws_1: ACCOUNT, ws_other: OTHER_ACCOUNT }

/** A reversible stand-in for `WebCryptoSecretCipher`, domain-separated by `info` like the real one. */
const fakeCipher = (info: string) => ({
  encrypt: async (v: string) => `sealed[${info}](${v})`,
  decrypt: async (v: string) => {
    const prefix = `sealed[${info}](`
    if (!v.startsWith(prefix) || !v.endsWith(')')) {
      throw new Error('key mismatch')
    }
    return v.slice(prefix.length, -1)
  },
})

const ENV_INFO = SEALED_SECRET_SOURCES.environment_access.info
const OBS_INFO = SEALED_SECRET_SOURCES.observability_connection.info

// The rows the mothership actually holds. Every repository read is workspace-scoped, so a row of
// another workspace is unreachable through an in-scope workspace id.
const ENVIRONMENTS: Record<
  string,
  { accessCipher: string | null; provisionFieldsCipher: string | null }
> = {
  'ws_1:env_1': {
    accessCipher: `sealed[${ENV_INFO}]({"url":"https://env-1.test"})`,
    provisionFieldsCipher: `sealed[${ENV_INFO}]({"release":"r1"})`,
  },
  'ws_1:env_bare': { accessCipher: null, provisionFieldsCipher: null },
  'ws_other:env_other': {
    accessCipher: `sealed[${ENV_INFO}]({"url":"https://secret.internal"})`,
    provisionFieldsCipher: null,
  },
}

const OBSERVABILITY: Record<string, { credentials: string }> = {
  ws_1: { credentials: `sealed[${OBS_INFO}]({"apiKey":"dd-key"})` },
}

// The two source-connection tables. Keyed by `(workspaceId, source)` — the one-key arity that
// distinguishes them from the workspace-only observability read above.
const DOC_INFO = SEALED_SECRET_SOURCES.document_source_connection.info
const TASK_INFO = SEALED_SECRET_SOURCES.task_source_connection.info

const DOCUMENT_CONNECTIONS: Record<string, { credentialsCipher: string }> = {
  'ws_1:figma': { credentialsCipher: `sealed[${DOC_INFO}]({"token":"figma-pat"})` },
  'ws_other:figma': { credentialsCipher: `sealed[${DOC_INFO}]({"token":"other-org-pat"})` },
}

const TASK_CONNECTIONS: Record<string, { credentialsCipher: string }> = {
  'ws_1:jira': { credentialsCipher: `sealed[${TASK_INFO}]({"apiToken":"jira-token"})` },
}

interface AppOptions {
  cipher?: boolean
  repositories?: boolean
  readThrows?: boolean
  driftedKey?: boolean
}

function makeApp(opts: AppOptions = {}) {
  const container = {
    ...(opts.cipher === false
      ? {}
      : {
          secretCipherFor: (info: string) =>
            // A DRIFTED mothership key: its own envelopes no longer authenticate.
            opts.driftedKey ? fakeCipher(`${info}:rotated`) : fakeCipher(info),
        }),
    repositories:
      opts.repositories === false
        ? undefined
        : {
            workspaceRepository: {
              accountOf: async (id: string) => ACCOUNT_BY_WORKSPACE[id] ?? null,
            },
            environmentRegistryRepository: {
              get: async (workspaceId: string, id: string) => {
                if (opts.readThrows) throw new Error('db down')
                return ENVIRONMENTS[`${workspaceId}:${id}`] ?? null
              },
            },
            observabilityConnectionRepository: {
              get: async (workspaceId: string) => OBSERVABILITY[workspaceId] ?? null,
            },
            documentConnectionRepository: {
              getByWorkspace: async (workspaceId: string, source: string) =>
                DOCUMENT_CONNECTIONS[`${workspaceId}:${source}`] ?? null,
            },
            taskConnectionRepository: {
              getByWorkspace: async (workspaceId: string, source: string) =>
                TASK_CONNECTIONS[`${workspaceId}:${source}`] ?? null,
            },
          },
    config: { auth: { sessionSecret: SECRET } },
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', secretDelegationController())
  app.onError(handleError)
  return app
}

async function machineToken(accountIds = [ACCOUNT]) {
  return (await mintMachineToken(SECRET, { userId: 'usr_1', accountIds })).token
}

function post(
  app: Hono<AppEnv>,
  route: 'seal' | 'unseal',
  token: string | undefined,
  body: unknown,
) {
  return app.fetch(
    new Request(`http://x/internal/secrets/${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

const ACCESS_REQUEST = {
  source: 'environment_access',
  workspaceId: 'ws_1',
  key: ['env_1'],
}

describe('POST /internal/secrets/unseal', () => {
  it('opens the mothership-held row for an in-scope workspace', async () => {
    const res = await post(makeApp(), 'unseal', await machineToken(), ACCESS_REQUEST)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, plaintext: '{"url":"https://env-1.test"}' })
  })

  it('opens each declared source through its own read, field and info tag', async () => {
    const token = await machineToken()
    const fields = await post(makeApp(), 'unseal', token, {
      source: 'environment_provision_fields',
      workspaceId: 'ws_1',
      key: ['env_1'],
    })
    expect(await fields.json()).toEqual({ ok: true, plaintext: '{"release":"r1"}' })

    // A workspace-keyed source takes NO key at all: arity comes from the table, not the caller.
    const obs = await post(makeApp(), 'unseal', token, {
      source: 'observability_connection',
      workspaceId: 'ws_1',
    })
    expect(await obs.json()).toEqual({ ok: true, plaintext: '{"apiKey":"dd-key"}' })
  })

  it('opens the STORED row, never a caller-supplied envelope (the non-oracle property)', async () => {
    // The whole reason the wire names a ROW: ciphertext obtained anywhere at all must not be
    // openable. Extra body fields are inert, and the answer is the mothership's own row.
    const res = await post(makeApp(), 'unseal', await machineToken(), {
      ...ACCESS_REQUEST,
      envelope: `sealed[${ENV_INFO}]({"stolen":"from another tenant"})`,
      ciphertext: `sealed[${ENV_INFO}]({"stolen":"from another tenant"})`,
    })
    expect(await res.json()).toEqual({ ok: true, plaintext: '{"url":"https://env-1.test"}' })
  })

  it('refuses a workspace owned by an out-of-scope account (404, no leak)', async () => {
    const res = await post(makeApp(), 'unseal', await machineToken(), {
      source: 'environment_access',
      workspaceId: 'ws_other',
      key: ['env_other'],
    })
    expect(res.status).toBe(404)
  })

  it('refuses an unknown workspace (404, no leak)', async () => {
    const res = await post(makeApp(), 'unseal', await machineToken(), {
      ...ACCESS_REQUEST,
      workspaceId: 'ws_nope',
    })
    expect(res.status).toBe(404)
  })

  it('refuses a row the in-scope workspace does not own (404)', async () => {
    // The row exists, under ws_other. Addressing it through the in-scope ws_1 must not reach it:
    // the workspaceId is PREPENDED by the controller, so the read is workspace-scoped.
    const res = await post(makeApp(), 'unseal', await machineToken(), {
      source: 'environment_access',
      workspaceId: 'ws_1',
      key: ['env_other'],
    })
    expect(res.status).toBe(404)
  })

  it('answers a row holding no sealed value with the SAME 404 as an absent one', async () => {
    const res = await post(makeApp(), 'unseal', await machineToken(), {
      ...ACCESS_REQUEST,
      key: ['env_bare'],
    })
    expect(res.status).toBe(404)
  })

  it('refuses a source outside the closed table, including prototype members (422)', async () => {
    const token = await machineToken()
    for (const source of ['slack_connection', '__proto__', 'constructor', 'toString', '']) {
      const res = await post(makeApp(), 'unseal', token, { source, workspaceId: 'ws_1', key: [] })
      expect(res.status, `source ${JSON.stringify(source)}`).toBe(422)
    }
  })

  it('refuses a key whose arity disagrees with the declaration (422, never a shifted read)', async () => {
    const token = await machineToken()
    // Too few: the read would silently target a different row than the caller named.
    expect((await post(makeApp(), 'unseal', token, { ...ACCESS_REQUEST, key: [] })).status).toBe(
      422,
    )
    // Too many: an argument the port never declared.
    expect(
      (await post(makeApp(), 'unseal', token, { ...ACCESS_REQUEST, key: ['env_1', 'extra'] }))
        .status,
    ).toBe(422)
    // Wrong element type.
    expect(
      (await post(makeApp(), 'unseal', token, { ...ACCESS_REQUEST, key: [{ id: 'env_1' }] }))
        .status,
    ).toBe(422)
  })

  it('rejects a missing/invalid machine token (403) BEFORE any availability probe', async () => {
    expect((await post(makeApp(), 'unseal', undefined, ACCESS_REQUEST)).status).toBe(403)
    // A facade with no cipher and no registry must still answer 403 first: availability is not
    // probeable without a valid token, matching every other `/internal/*` surface.
    const bare = makeApp({ cipher: false, repositories: false })
    expect((await post(bare, 'unseal', undefined, ACCESS_REQUEST)).status).toBe(403)
    expect((await post(bare, 'seal', undefined, ACCESS_REQUEST)).status).toBe(403)
  })

  it('rejects a non-machine audience token (403)', async () => {
    const session = await new HmacSigner(SECRET).sign({
      id: 'usr_1',
      login: 'dev',
      name: 'Dev',
      avatarUrl: null,
      aud: TOKEN_AUDIENCE.session,
      exp: Date.now() + 60_000,
    })
    expect((await post(makeApp(), 'unseal', session, ACCESS_REQUEST)).status).toBe(403)
  })

  it('rejects a token signed with another secret (403)', async () => {
    const foreign = (
      await mintMachineToken('another-secret-0123456789', {
        userId: 'usr_1',
        accountIds: [ACCOUNT],
      })
    ).token
    expect((await post(makeApp(), 'unseal', foreign, ACCESS_REQUEST)).status).toBe(403)
  })

  it('503s on a deployment that is not a mothership or wired no cipher (after auth)', async () => {
    const token = await machineToken()
    expect((await post(makeApp({ cipher: false }), 'unseal', token, ACCESS_REQUEST)).status).toBe(
      503,
    )
    expect(
      (await post(makeApp({ repositories: false }), 'unseal', token, ACCESS_REQUEST)).status,
    ).toBe(503)
    expect((await post(makeApp({ cipher: false }), 'seal', token, ACCESS_REQUEST)).status).toBe(503)
  })

  it('500s (never 404) when the row read fails or the mothership key drifted', async () => {
    const token = await machineToken()
    // Both are the MOTHERSHIP's own fault, and both must be distinguishable from "nothing here":
    // a node reading a 404 as an empty credential would provision against nothing.
    expect(
      (await post(makeApp({ readThrows: true }), 'unseal', token, ACCESS_REQUEST)).status,
    ).toBe(500)
    expect(
      (await post(makeApp({ driftedKey: true }), 'unseal', token, ACCESS_REQUEST)).status,
    ).toBe(500)
  })

  it('422s a malformed body', async () => {
    const token = await machineToken()
    const res = await makeApp().fetch(
      new Request('http://x/internal/secrets/unseal', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: 'not json',
      }),
    )
    expect(res.status).toBe(422)
  })
})

describe('POST /internal/secrets/seal', () => {
  it('seals under the ORG key for an in-scope workspace', async () => {
    const res = await post(makeApp(), 'seal', await machineToken(), {
      source: 'environment_access',
      workspaceId: 'ws_1',
      plaintext: '{"url":"https://fresh.test"}',
    })
    expect(res.status).toBe(200)
    const { envelope } = (await res.json()) as { envelope: string }
    // The round trip that matters: what the node stores is what the MOTHERSHIP can later open.
    expect(await fakeCipher(ENV_INFO).decrypt(envelope)).toBe('{"url":"https://fresh.test"}')
  })

  it('refuses an out-of-scope workspace (404) and an undeclared source (422)', async () => {
    const token = await machineToken()
    expect(
      (
        await post(makeApp(), 'seal', token, {
          source: 'environment_access',
          workspaceId: 'ws_other',
          plaintext: 'x',
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await post(makeApp(), 'seal', token, {
          source: '__proto__',
          workspaceId: 'ws_1',
          plaintext: 'x',
        })
      ).status,
    ).toBe(422)
  })

  it('requires a plaintext (422)', async () => {
    const res = await post(makeApp(), 'seal', await machineToken(), {
      source: 'environment_access',
      workspaceId: 'ws_1',
    })
    expect(res.status).toBe(422)
  })
})

describe('the document / task source connections', () => {
  // The last integration to reach a mothership-mode node, and the reason it was last: its
  // repositories decrypted INSIDE, so there was no sealed field for a row-addressed unseal to name.
  // These assert the binding that closed it — the right row, under the right HKDF domain, reached
  // by a source-keyed read whose workspace half the node does not get to choose.
  const app = makeApp()

  it('opens a document-source bag by (workspace, source)', async () => {
    const res = await post(app, 'unseal', await machineToken(), {
      source: 'document_source_connection',
      workspaceId: 'ws_1',
      key: ['figma'],
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, plaintext: '{"token":"figma-pat"}' })
  })

  it('opens a tracker bag by (workspace, source)', async () => {
    const res = await post(app, 'unseal', await machineToken(), {
      source: 'task_source_connection',
      workspaceId: 'ws_1',
      key: ['jira'],
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, plaintext: '{"apiToken":"jira-token"}' })
  })

  it('cannot reach another account`s connection through an in-scope workspace id', async () => {
    // `workspaceId` is PREPENDED server-side, so naming `ws_other` is a scope refusal rather than
    // a read — the row exists and stays a uniform 404.
    const res = await post(app, 'unseal', await machineToken(), {
      source: 'document_source_connection',
      workspaceId: 'ws_other',
      key: ['figma'],
    })
    expect(res.status).toBe(404)
  })

  it('refuses a workspace-only key: the arity is part of the row`s address', async () => {
    // A short key would read a DIFFERENT row than the caller named, because the args are spread.
    const res = await post(app, 'unseal', await machineToken(), {
      source: 'task_source_connection',
      workspaceId: 'ws_1',
    })
    expect(res.status).toBe(422)
  })

  it('404s a source the workspace has never connected', async () => {
    const res = await post(app, 'unseal', await machineToken(), {
      source: 'task_source_connection',
      workspaceId: 'ws_1',
      key: ['linear'],
    })
    expect(res.status).toBe(404)
  })
})

describe('the source table', () => {
  it('binds EXACTLY the kernel vocabulary, with no unbound or extra member', () => {
    // Derived from the same source the code reads rather than pinned to a count: adding a source
    // must fail for the RIGHT reason (an unbound member), not because a number moved.
    expect(Object.keys(SEALED_SECRET_SOURCES).sort()).toEqual([...ORG_SECRET_SOURCES].sort())
    for (const [source, spec] of Object.entries(SEALED_SECRET_SOURCES)) {
      expect(spec.repo, source).toMatch(/Repository$/)
      expect(spec.method.length, source).toBeGreaterThan(0)
      expect(spec.field.length, source).toBeGreaterThan(0)
      expect(spec.info, source).toMatch(/^cat-factory:/)
    }
  })

  it('resolves a binding whose key arity comes from the KERNEL declaration, never a local copy', () => {
    // Arity is the one part of a binding the CALLER also has to get right, and it cannot see this
    // table. Restated here it was prose a call site could disagree with in silence — a store that
    // sent no key passed every hosted test (a local cipher ignores the ref) and answered 422 on
    // every open on the only deployment shape that delegates. One declaration, read by both halves.
    for (const source of ORG_SECRET_SOURCES) {
      expect(sealedSecretSourceSpec(source)?.keyArity, source).toBe(ORG_SECRET_KEY_ARITY[source])
    }
  })

  it('refuses a key whose arity disagrees with the source, in EITHER direction', async () => {
    const token = await machineToken()
    // Too few: the args are spread into the declared read, so a short list would silently read a
    // DIFFERENT row than the caller named. Too many passes an argument the port never declared.
    for (const key of [undefined, [], ['jira', 'extra']]) {
      const res = await makeApp().request('/internal/secrets/unseal', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          source: 'task_source_connection',
          workspaceId: 'ws_1',
          ...(key ? { key } : {}),
        }),
      })
      expect(res.status, JSON.stringify(key)).toBe(422)
    }
  })
})

describe('HttpSecretDelegate', () => {
  const mothership = makeApp()
  const delegate = (token: string | (() => string | null)) =>
    new HttpSecretDelegate({
      baseUrl: 'http://mothership.test',
      token,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
        mothership.fetch(new Request(input as string | URL | Request, init))) as typeof fetch,
    })

  it('round-trips an unseal against the real endpoint', async () => {
    const client = delegate(await machineToken())
    await expect(
      client.unseal({ source: 'environment_access', workspaceId: 'ws_1', key: ['env_1'] }),
    ).resolves.toBe('{"url":"https://env-1.test"}')
  })

  it('composes into createOrgSecretCipher so a service opens a mothership-sealed row unchanged', async () => {
    // The consumer-side contract in one assertion: a service holding the LOCAL cipher (which
    // cannot open this envelope at all) still reads the value, because the ref routes upstream.
    const org = createOrgSecretCipher({
      cipher: fakeCipher('some-other-local-key'),
      delegate: delegate(await machineToken()),
    })
    await expect(
      org.decryptFor(
        { source: 'environment_access', workspaceId: 'ws_1', key: ['env_1'] },
        ENVIRONMENTS['ws_1:env_1']!.accessCipher!,
      ),
    ).resolves.toBe('{"url":"https://env-1.test"}')
  })

  it('THROWS rather than degrading, on a refusal and on a token-less node alike', async () => {
    // A client that answered with an empty credential would be read as "this connection holds
    // nothing", which is the false-zero this whole initiative treats as the worst failure.
    const scoped = delegate(await machineToken())
    await expect(
      scoped.unseal({ source: 'environment_access', workspaceId: 'ws_other', key: ['env_other'] }),
    ).rejects.toThrow('HTTP 404')

    await expect(
      delegate(() => null).unseal({ source: 'observability_connection', workspaceId: 'ws_1' }),
    ).rejects.toBeInstanceOf(MachineSecretDelegationUnavailableError)
    await expect(
      delegate(() => null).seal({ source: 'observability_connection', workspaceId: 'ws_1' }, 'x'),
    ).rejects.toBeInstanceOf(MachineSecretDelegationUnavailableError)
  })

  it('round-trips a seal, and what it returns is what the mothership can open', async () => {
    const client = delegate(await machineToken())
    const envelope = await client.seal(
      { source: 'observability_connection', workspaceId: 'ws_1' },
      '{"apiKey":"fresh"}',
    )
    expect(await fakeCipher(OBS_INFO).decrypt(envelope)).toBe('{"apiKey":"fresh"}')
  })
})
