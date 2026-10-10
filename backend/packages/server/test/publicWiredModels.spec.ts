import type { PersonalSubscriptionService, PublicApiKeyService } from '@cat-factory/integrations'
import { DEFAULT_SPEND_PRICING } from '@cat-factory/spend'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { publicProvisioningController } from '../src/modules/publicApi/PublicProvisioningController.js'

// What `GET /api/v1/models` says about a model nobody can dispatch to, which is the only part of
// this read anyone has ever been misled by.
//
// `available: false` is one answer to four unrelated questions, and the row's job is to say WHICH:
// nothing is wired, a policy refuses it, a person's credential was never consulted, or a person's
// credential is right there and this token may not spend it. The last is the one a deployment
// running every day on a Claude subscription actually hits, and the one that used to render as "no
// provider wired for it", sending its operator to buy an API key for a model they already pay for.
//
// Driven through the real controller with stubbed stores rather than through the catalog helpers,
// because both bugs this pins lived in the PROJECTION: the flags are derived from the catalog row
// at this seam, and a helper-level test would have agreed with the code and shipped anyway.

const KEY_MINTER = 'usr_minter'

type KeyShape = { actsAsUserId: string | null; createdByUserId: string | null }

const KEYS: Record<string, KeyShape> = {
  // The default a workspace mints: a service credential belonging to nobody, minted by a person.
  'system.secret': { actsAsUserId: null, createdByUserId: KEY_MINTER },
  // Minted with "Runs as" set to self: its runs ARE that person's.
  'personal.secret': { actsAsUserId: KEY_MINTER, createdByUserId: KEY_MINTER },
  // Provisioned headlessly through `POST /api/v1/keys`, which holds nobody's consent to inherit.
  'provisioned.secret': { actsAsUserId: null, createdByUserId: null },
}

function build(
  options: { subscribedVendors?: string[]; personalStore?: boolean } = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const personalSubscriptions = {
    liveVendors: async (userId: string) =>
      new Set(userId === KEY_MINTER ? (options.subscribedVendors ?? []) : []),
  } as unknown as PersonalSubscriptionService
  const container = {
    publicApiKeys: {
      authenticate: async (raw?: string) => {
        const key = raw ? KEYS[raw] : undefined
        return key
          ? {
              keyId: 'pak_1',
              accountId: 'acc_1',
              workspaceId: 'ws_1',
              scope: 'admin' as const,
              label: 'acceptance',
              externalIdentity: null,
              createdAt: 1_700_000_000_000,
              ...key,
            }
          : null
      },
    } as unknown as PublicApiKeyService,
    ...(options.personalStore === false ? {} : { personalSubscriptions }),
    // Nothing else is wired: no provider key, no pooled subscription, no Cloudflare lib. So every
    // model in the catalog is unavailable, which is exactly the deployment shape this is about.
    workspaceService: { accountOf: async () => null },
    // The real pricing table: the catalog projects a list price per row, so a stub without one
    // fails every model rather than the one under test.
    config: { spend: DEFAULT_SPEND_PRICING },
  } as unknown as ServerContainer
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.onError(handleError)
  app.route('/', publicProvisioningController())
  return app
}

const withKey = (secret: string) => ({ headers: { authorization: `Bearer ${secret}` } })

async function rowFor(app: Hono<AppEnv>, secret: string, modelId: string) {
  const res = await app.request('/api/v1/models', withKey(secret))
  // The body on a non-200, because a stub container that is one field short answers 500 and the
  // status alone names neither the field nor the read that wanted it.
  if (res.status !== 200) throw new Error(`${res.status}: ${await res.text()}`)
  const body = (await res.json()) as {
    models: {
      modelId: string
      available: boolean
      userScoped: boolean
      personalSubscription: boolean
      subscriptionConfigured: boolean | null
    }[]
  }
  const row = body.models.find((model) => model.modelId === modelId)
  if (!row) throw new Error(`the catalog carries no '${modelId}' row to assert on`)
  return row
}

describe('GET /api/v1/models: which models belong to a PERSON', () => {
  // `claude-opus` is the model the built-in Claude preset pins and the one every report of this bug
  // has been about. It declares TWO routes (OpenRouter and the subscription), and with neither
  // configured the catalog resolves it to the most-preferred DECLARED one, OpenRouter. So a flag
  // read off the route IN FORCE answers false here, for the single commonest personal credential in
  // the product, and `userScoped` (which is exactly that reading) never fired for it.
  it('marks a model reachable by subscription as personal even when another route wins', async () => {
    const row = await rowFor(build(), 'system.secret', 'claude-opus')
    expect(row.available).toBe(false)
    expect(row.personalSubscription).toBe(true)
  })

  it('marks a subscription-ONLY model as personal', async () => {
    expect((await rowFor(build(), 'system.secret', 'claude-sonnet')).personalSubscription).toBe(
      true,
    )
  })

  it('leaves a model with no subscription route alone', async () => {
    const row = await rowFor(build(), 'system.secret', 'claude-opus-4-8')
    expect(row.personalSubscription).toBe(false)
    // No vendor to ask about, so there is no answer rather than a negative one.
    expect(row.subscriptionConfigured).toBeNull()
  })

  it('does NOT mark a POOLABLE vendor’s model as personal', async () => {
    // Kimi and DeepSeek are licensed for org use, so their token is held by the WORKSPACE and every
    // key can see it. Flagging one as belonging to a person is not a harmless over-report: it is
    // what makes the suite tell an operator to re-mint their token when the fix is a pooled token
    // or a provider key, and no identity is missing at all.
    const row = await rowFor(build(), 'system.secret', 'kimi')
    expect(row.personalSubscription).toBe(false)
    expect(row.subscriptionConfigured).toBeNull()
  })

  it('keeps the superseded `userScoped` answering the route IN FORCE', async () => {
    // Published at 1.45.0 and branched on by consumers, so it is served beside its replacement
    // rather than corrected under them. Which means it stays WRONG in the direction that made a
    // new field necessary, and this pins that as deliberate rather than as an oversight: false for
    // the Claude preset's own model, whose declared subscription lost the route race to OpenRouter.
    expect((await rowFor(build(), 'system.secret', 'claude-opus')).userScoped).toBe(false)
    expect((await rowFor(build(), 'system.secret', 'claude-sonnet')).userScoped).toBe(true)
  })
})

describe('GET /api/v1/models: whether the credential is actually there', () => {
  it('tells a SYSTEM token its owner’s subscription is connected, without admitting it', async () => {
    const row = await rowFor(
      build({ subscribedVendors: ['claude'] }),
      'system.secret',
      'claude-opus',
    )
    // The whole point: wired, and still not dispatchable by THIS credential. Reporting either half
    // alone is a lie: `available: true` promises a run that would be refused at start, and
    // `subscriptionConfigured: false` sends its operator to buy a key they do not need.
    expect(row.subscriptionConfigured).toBe(true)
    expect(row.available).toBe(false)
  })

  it('resolves existence for a BOUND token, which can also spend it', async () => {
    const row = await rowFor(
      build({ subscribedVendors: ['claude'] }),
      'personal.secret',
      'claude-opus',
    )
    expect(row.subscriptionConfigured).toBe(true)
    expect(row.available).toBe(true)
  })

  it('answers false where the owner is known and holds nothing for that vendor', async () => {
    const row = await rowFor(
      build({ subscribedVendors: ['codex'] }),
      'system.secret',
      'claude-opus',
    )
    expect(row.subscriptionConfigured).toBe(false)
    expect(row.personalSubscription).toBe(true)
  })

  it('answers NULL, never false, when there is no person to ask about', async () => {
    // A headlessly provisioned key has no minter, so nobody was consulted. "There is none" and "we
    // asked nobody" take different fixes: the first is a subscription to connect, the second a
    // token minted in the app instead.
    const row = await rowFor(
      build({ subscribedVendors: ['claude'] }),
      'provisioned.secret',
      'claude-opus',
    )
    expect(row.subscriptionConfigured).toBeNull()
    expect(row.personalSubscription).toBe(true)
  })

  it('answers NULL on a deployment that stores no personal subscriptions', async () => {
    const row = await rowFor(build({ personalStore: false }), 'system.secret', 'claude-opus')
    expect(row.subscriptionConfigured).toBeNull()
  })
})
