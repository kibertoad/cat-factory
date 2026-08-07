import { describe, expect, it } from 'vitest'
import type {
  DocumentConnectionRecord,
  DocumentSourceKind,
  DocumentSourceProvider,
} from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { FigmaProvider } from './FigmaProvider.js'
import { NotionProvider } from './NotionProvider.js'
import { MapDocumentSourceRegistry } from './documents.logic.js'
import {
  DocumentSourceOAuthService,
  type DocumentOAuthClient,
} from './DocumentSourceOAuthService.js'

// The shared `authorization_code` flow, exercised through the one provider that declares an OAuth
// half. `fetch` is a recorded fake; no network. What is under test is the platform's half — which
// sources are OFFERED, what the authorize URL carries, the bag an exchange produces, and the four
// renewal outcomes — not Figma's protocol, which is four constants in `figma.logic`.

const CLIENT: DocumentOAuthClient = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUrl: 'https://app.test/documents/oauth/callback',
}

const NOW = 1_700_000_000_000

function build(
  options: {
    providers?: DocumentSourceProvider[]
    clients?: Partial<Record<DocumentSourceKind, DocumentOAuthClient>>
    respond?: (url: string, body: URLSearchParams) => Response
  } = {},
) {
  const calls: Array<{ url: string; params: Record<string, string>; auth: string }> = []
  const logger = createRecordingLogger()
  const service = new DocumentSourceOAuthService({
    registry: new MapDocumentSourceRegistry(
      options.providers ?? [new FigmaProvider(), new NotionProvider()],
    ),
    resolveClient: async (_workspaceId, source) => (options.clients ?? { figma: CLIENT })[source],
    clock: { now: () => NOW },
    logger,
    fetchImpl: (async (url: string, init: RequestInit) => {
      const params = init.body as URLSearchParams
      calls.push({
        url,
        params: Object.fromEntries(params),
        auth: (init.headers as Record<string, string>).authorization ?? '',
      })
      return (
        options.respond?.(url, params) ??
        new Response(
          JSON.stringify({ access_token: 'at_1', refresh_token: 'rt_1', expires_in: 90 }),
        )
      )
    }) as unknown as typeof fetch,
  })
  return { service, calls, lines: logger.lines }
}

function grant(credentials: Record<string, string>): DocumentConnectionRecord {
  return {
    workspaceId: 'ws_1',
    source: 'figma',
    credentials,
    label: 'Figma',
    createdAt: NOW,
    deletedAt: null,
  }
}

describe('half-declared OAuth', () => {
  // The two declarations state one fact for two audiences (the flow, and the SPA that cannot see
  // kernel), and nothing but this check forces them together. Both directions of the omission are
  // SILENT in production — one hides the flow behind a button no surface renders, the other renders
  // a button whose only outcome is `oauth_not_supported` — so the registry refuses them at
  // registration, which is the last point at which the mistake is still a code change.
  function providerWith(overrides: Partial<DocumentSourceProvider>): DocumentSourceProvider {
    return Object.assign(Object.create(FigmaProvider.prototype) as DocumentSourceProvider, {
      ...new FigmaProvider(),
      ...overrides,
    })
  }

  it('refuses a spec with no descriptor half', () => {
    const figma = new FigmaProvider()
    const specOnly = providerWith({
      descriptor: { ...figma.descriptor, oauth: undefined },
    })
    expect(() => new MapDocumentSourceRegistry([specOnly])).toThrow(
      /declares provider\.oauth but not descriptor\.oauth/,
    )
  })

  it('refuses a descriptor half with no spec', () => {
    const wireOnly = providerWith({ oauth: undefined })
    expect(() => new MapDocumentSourceRegistry([wireOnly])).toThrow(
      /declares descriptor\.oauth but not provider\.oauth/,
    )
  })

  it('refuses scopes the operator would consent to that are not the ones requested', () => {
    const figma = new FigmaProvider()
    const drifted = providerWith({
      descriptor: { ...figma.descriptor, oauth: { scopes: ['file_content:read'] } },
    })
    expect(() => new MapDocumentSourceRegistry([drifted])).toThrow(
      /descriptor shows \[file_content:read\]/,
    )
  })

  it('accepts the shipped providers as they are', () => {
    expect(
      () => new MapDocumentSourceRegistry([new FigmaProvider(), new NotionProvider()]),
    ).not.toThrow()
  })
})

describe('availableSources', () => {
  it('needs BOTH a declared OAuth half and a registered client', async () => {
    // Notion declares no half; Figma declares one, and the deployment has an app for it.
    expect(await build().service.availableSources('ws_1')).toEqual(['figma'])
    // The same source with no registered app is NOT offered: a button that can only 503 is the
    // misattribution the separate wire field exists to prevent.
    expect(await build({ clients: {} }).service.availableSources('ws_1')).toEqual([])
  })
})

describe('authorizeUrl', () => {
  it('carries the registered redirect, the scopes joined the vendor way, and the state', async () => {
    const { service } = build()
    const url = new URL(
      await service.authorizeUrl({ workspaceId: 'ws_1', source: 'figma', state: 'signed.state' }),
    )
    expect(url.origin + url.pathname).toBe('https://www.figma.com/oauth')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: CLIENT.redirectUrl,
      // Comma-joined, per the source's own `scopeSeparator`: a space-joined scope is silently
      // read by Figma as one unknown scope.
      scope: 'file_content:read,file_variables:read',
      state: 'signed.state',
      response_type: 'code',
    })
  })

  it('refuses a source with no OAuth half, and a deployment with no registered app, differently', async () => {
    await expect(
      build().service.authorizeUrl({ workspaceId: 'ws_1', source: 'notion', state: 's' }),
    ).rejects.toThrow(/does not support connecting by OAuth/)
    await expect(
      build({ clients: {} }).service.authorizeUrl({
        workspaceId: 'ws_1',
        source: 'figma',
        state: 's',
      }),
    ).rejects.toThrow(/no registered Figma app/)
  })
})

describe('exchangeCode', () => {
  it('posts the code as a confidential client and answers the platform-owned bag', async () => {
    const { service, calls } = build()
    const credentials = await service.exchangeCode({
      workspaceId: 'ws_1',
      source: 'figma',
      code: 'the-code',
    })
    expect(calls).toEqual([
      {
        url: 'https://api.figma.com/v1/oauth/token',
        params: {
          grant_type: 'authorization_code',
          code: 'the-code',
          redirect_uri: CLIENT.redirectUrl,
        },
        auth: `Basic ${btoa('cid:csecret')}`,
      },
    ])
    // The lifetime is stored as an ABSOLUTE deadline: the bag is read days later by a dispatch
    // that has no idea when the grant happened.
    expect(credentials).toEqual({
      oauthAccessToken: 'at_1',
      oauthRefreshToken: 'rt_1',
      oauthExpiresAt: String(NOW + 90_000),
    })
  })

  it('states a refusal from the authorization server rather than storing an empty grant', async () => {
    const { service } = build({
      respond: () =>
        new Response(JSON.stringify({ error_description: 'bad redirect' }), { status: 400 }),
    })
    await expect(
      service.exchangeCode({ workspaceId: 'ws_1', source: 'figma', code: 'x' }),
    ).rejects.toThrow(/HTTP 400.*bad redirect/)
  })
})

describe('renewIfExpiring', () => {
  it('does nothing for a bag with no deadline, or one still comfortably live', async () => {
    const { service, calls, lines } = build()
    expect(await service.renewIfExpiring(grant({ apiToken: 'figd_x' }))).toBeNull()
    expect(
      await service.renewIfExpiring(
        grant({ oauthAccessToken: 'at', oauthExpiresAt: String(NOW + 3_600_000) }),
      ),
    ).toBeNull()
    expect(calls).toEqual([])
    // SILENTLY nothing, which the call count alone cannot say. A missing deadline used to convert
    // to 0 and read as "expired at the epoch", so this same PAT bag fell through to the renewal
    // path and reported a permanent source outage on every credential resolution.
    expect(lines).toEqual([])
  })

  it('treats a bag whose deadline is absent or garbled as having none, not as expired', async () => {
    const { service, calls, lines } = build()
    // A grant that COULD be refreshed, so the only thing keeping it off the refresh path is the
    // reading of its deadline. Both spellings of "no usable deadline" must answer the same way.
    for (const oauthExpiresAt of ['', '   ', 'not-a-number']) {
      expect(
        await service.renewIfExpiring(
          grant({ oauthAccessToken: 'at_1', oauthRefreshToken: 'rt_1', oauthExpiresAt }),
        ),
      ).toBeNull()
    }
    expect(calls).toEqual([])
    expect(lines).toEqual([])
  })

  it('renews inside the skew and CARRIES FORWARD a refresh token the response omitted', async () => {
    const { service, calls } = build({
      // The common shape: a new access token against the unchanged refresh token.
      respond: () => new Response(JSON.stringify({ access_token: 'at_2', expires_in: 3600 })),
    })
    const renewed = await service.renewIfExpiring(
      grant({
        oauthAccessToken: 'at_1',
        oauthRefreshToken: 'rt_1',
        oauthExpiresAt: String(NOW + 30_000),
      }),
    )
    expect(calls[0]?.url).toBe('https://api.figma.com/v1/oauth/refresh')
    expect(calls[0]?.params).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt_1' })
    // Taking the response literally would strip the ability to renew AGAIN, turning a working
    // grant into a one-shot one.
    expect(renewed).toEqual({
      oauthAccessToken: 'at_2',
      oauthRefreshToken: 'rt_1',
      oauthExpiresAt: String(NOW + 3_600_000),
    })
  })

  it('names WHY it could not renew instead of throwing into the read path', async () => {
    const expired = { oauthAccessToken: 'at_1', oauthExpiresAt: String(NOW - 1) }

    const noToken = build()
    expect(await noToken.service.renewIfExpiring(grant(expired))).toBeNull()
    expect(noToken.lines.at(-1)?.fields?.cause).toBe('grant_has_no_refresh_token')

    const failing = build({ respond: () => new Response('nope', { status: 503 }) })
    expect(
      await failing.service.renewIfExpiring(grant({ ...expired, oauthRefreshToken: 'rt_1' })),
    ).toBeNull()
    expect(failing.lines.at(-1)?.msg).toMatch(/refresh failed/)
  })
})
