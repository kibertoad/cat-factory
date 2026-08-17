import { apiKeyProviderSchema, LOCAL_RUNNERS } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  cloudflareRestBaseUrl,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URLS,
  isDirectProvider,
  isOpenAiCompatibleProvider,
  isOperatorHostedGateway,
  isProxyableProvider,
  OPENAI_COMPATIBLE_PROVIDERS,
  OPERATOR_HOSTED_GATEWAYS,
  resolveOpenAiCompatibleBaseUrl,
  UI_CONFIGURABLE_DIRECT_PROVIDERS,
} from './endpoints.js'

// The shared provider table and everything derived from it.
//
// The assertions worth writing here are the ones a derivation cannot make for itself. The table
// feeds several DIFFERENT derivations (the exported gateway list, the defaults map, the key-pool
// vocabulary in `@cat-factory/contracts`), and each is written independently of the others: an
// assertion that recomputes one of them the way its own source does is a tautology that passes on
// an emitter whose bug is consistent in both halves. So the cases below either cross-check two
// independent derivations against each other, or pin a claim about the WORLD (which gateways this
// platform ships as operator-hosted, what each vendor's endpoint is) that no derivation can check.

/**
 * The endpoint-less members, recomputed from the DEFAULTS map rather than read off
 * {@link OPERATOR_HOSTED_GATEWAYS}, so the two derivations of "which gateway is operator-hosted"
 * (a `=== null` filter over the table, and an absence from the defaults built by dropping nulls)
 * can be checked against each other rather than each asserted against itself.
 */
const ENDPOINT_LESS = OPENAI_COMPATIBLE_PROVIDERS.filter(
  (provider) => !Object.hasOwn(DEFAULT_OPENAI_COMPATIBLE_BASE_URLS, provider),
)

describe('the OpenAI-compatible provider table', () => {
  it('ships exactly Bifrost and LiteLLM as operator-hosted gateways', () => {
    // A pinned pair, deliberately: which gateways this platform ships support for is a product
    // fact, not something to recompute. Adding a third is a real decision (its own catalog entry,
    // its own remedy label, its own `${PROVIDER}_BASE_URL` on both facades), so it should update
    // this line rather than extend silently.
    expect(ENDPOINT_LESS).toEqual(['bifrost', 'litellm'])
  })

  it('derives the exported gateway list and predicate from the same members', () => {
    expect([...OPERATOR_HOSTED_GATEWAYS]).toEqual(ENDPOINT_LESS)
    for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
      expect(isOperatorHostedGateway(provider)).toBe(ENDPOINT_LESS.includes(provider))
    }
  })

  it('gives every other member a DISTINCT https endpoint', () => {
    // Distinctness is the assertion no type or derivation can make: every entry is a
    // `string`, so a vendor's URL copy-pasted onto its neighbour typechecks, derives cleanly,
    // and silently bills one vendor's key against another's endpoint.
    const resolved = OPENAI_COMPATIBLE_PROVIDERS.filter(
      (provider) => !ENDPOINT_LESS.includes(provider),
    ).map((provider) => resolveOpenAiCompatibleBaseUrl(provider, undefined))
    for (const url of resolved) expect(url).toMatch(/^https:\/\/[^\s]+$/)
    expect(new Set(resolved).size).toBe(resolved.length)
  })

  it('resolves an operator-hosted gateway only from its deployment override', () => {
    for (const provider of OPERATOR_HOSTED_GATEWAYS) {
      expect(resolveOpenAiCompatibleBaseUrl(provider, undefined)).toBeUndefined()
      // A set-but-blank override must not read as "configured": it falls back to the
      // (absent) default rather than collapsing to an empty URL the SDK then chokes on.
      expect(resolveOpenAiCompatibleBaseUrl(provider, '  ')).toBeUndefined()
      expect(resolveOpenAiCompatibleBaseUrl(provider, 'https://gw.internal/v1')).toBe(
        'https://gw.internal/v1',
      )
    }
  })

  it('keeps an Object.prototype key out of the defaults lookup', () => {
    // The defaults map is a plain object and this function takes an unnarrowed `string`, so an
    // unguarded index would answer `Object.prototype.toString`: a Function returned under a
    // `string | undefined` signature, which a caller's `!!baseUrl` check then reads as resolved.
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(resolveOpenAiCompatibleBaseUrl(key, undefined)).toBeUndefined()
    }
  })
})

describe('the direct-provider vocabulary', () => {
  it('matches the key-pool picklist in @cat-factory/contracts exactly', () => {
    // The one relation that catches the real drift: the pool vocabulary is authored in contracts
    // (a valibot picklist the SPA and the API validate against) and the direct-provider list is
    // derived here from the endpoint table. A gateway added to the table but not the picklist is a
    // provider whose key cannot be stored; the reverse is a key nothing can spend.
    expect([...UI_CONFIGURABLE_DIRECT_PROVIDERS].sort()).toEqual(
      [...apiKeyProviderSchema.options].sort(),
    )
  })

  it('is sorted, duplicate-free, and accepted by its own predicate', () => {
    expect([...UI_CONFIGURABLE_DIRECT_PROVIDERS]).toEqual(
      [...UI_CONFIGURABLE_DIRECT_PROVIDERS].sort(),
    )
    expect(new Set(UI_CONFIGURABLE_DIRECT_PROVIDERS).size).toBe(
      UI_CONFIGURABLE_DIRECT_PROVIDERS.length,
    )
    for (const provider of UI_CONFIGURABLE_DIRECT_PROVIDERS) {
      expect(isDirectProvider(provider)).toBe(true)
    }
  })

  it('rejects what is not reached with a pooled key', () => {
    for (const provider of ['workers-ai', 'bedrock', 'claude', 'codex', 'zai', 'ollama']) {
      expect(isDirectProvider(provider)).toBe(false)
    }
  })
})

describe('isOpenAiCompatibleProvider', () => {
  it('rejects the providers reached by their own SDK or binding', () => {
    // `anthropic` is the load-bearing one: it IS a direct, key-pooled provider with a
    // `${PROVIDER}_BASE_URL` override, and it must still stay out of this set, because the proxy
    // forwards an OpenAI-shaped body an Anthropic endpoint does not accept.
    expect(isOpenAiCompatibleProvider('anthropic')).toBe(false)
    expect(isOpenAiCompatibleProvider('workers-ai')).toBe(false)
    expect(isOpenAiCompatibleProvider('bedrock')).toBe(false)
  })

  it('does not treat Object.prototype keys as providers', () => {
    expect(isOpenAiCompatibleProvider('constructor')).toBe(false)
    expect(isOpenAiCompatibleProvider('toString')).toBe(false)
  })
})

describe('isProxyableProvider', () => {
  it('admits every key-poolable provider the proxy can forward, and refuses anthropic', () => {
    // Checked against the POOL vocabulary rather than the endpoint table this predicate reads:
    // a pooled key whose provider the container proxy cannot forward is a container step that
    // passes the start guard and then dies with "upstream not available", which is the exact
    // class of bug the shared table exists to close.
    for (const provider of apiKeyProviderSchema.options) {
      expect(isProxyableProvider(provider)).toBe(provider !== 'anthropic')
    }
  })

  it('admits workers-ai and every per-user local runner', () => {
    expect(isProxyableProvider('workers-ai')).toBe(true)
    for (const runner of LOCAL_RUNNERS) expect(isProxyableProvider(runner)).toBe(true)
  })

  it('refuses the vendors the proxy never forwards (subscription harnesses)', () => {
    for (const provider of ['anthropic', 'claude', 'codex', 'zai', 'bedrock']) {
      expect(isProxyableProvider(provider)).toBe(false)
    }
  })

  it('does not treat Object.prototype keys as providers', () => {
    expect(isProxyableProvider('constructor')).toBe(false)
    expect(isProxyableProvider('toString')).toBe(false)
  })
})

describe('cloudflareRestBaseUrl', () => {
  it('addresses the account REST endpoint, or an AI Gateway when one is named', () => {
    expect(cloudflareRestBaseUrl({ accountId: 'acct1' })).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct1/ai/v1',
    )
    expect(cloudflareRestBaseUrl({ accountId: 'acct1', gateway: 'gw' })).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct1/gw/workers-ai/v1',
    )
  })

  it('stays out of the OpenAI-compatible provider set', () => {
    // It is a function of the ACCOUNT, so it cannot be a constant in the shared table; the
    // `workers-ai` provider is reached through the binding or through this URL, never by a
    // `${PROVIDER}_BASE_URL` lookup.
    expect(isOpenAiCompatibleProvider('workers-ai')).toBe(false)
    expect(resolveOpenAiCompatibleBaseUrl('workers-ai', undefined)).toBeUndefined()
  })
})
