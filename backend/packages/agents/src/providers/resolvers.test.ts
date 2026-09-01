import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'
import { generateText, type LanguageModel } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import {
  baseProviderRegistry,
  directOpenAiCompatibleResolver,
  openAiCompatibleResolver,
  openRouterResolver,
} from './resolvers.js'

/**
 * A transport that records the request body and then refuses, so a test can assert what a
 * resolved model puts ON THE WIRE.
 *
 * The wire is the only place these assertions are worth making: the two clients are
 * indistinguishable through the `ModelResolver` type, and every option here is interesting
 * solely through the field it emits.
 */
function capturingFetch(): {
  fetch: typeof fetch
  bodies: Record<string, unknown>[]
  urls: string[]
} {
  const bodies: Record<string, unknown>[] = []
  const urls: string[] = []
  const fake = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    urls.push(String(url))
    if (typeof init?.body === 'string')
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    throw new Error('captured-by-injected-fetch')
  }) as unknown as typeof fetch
  return { fetch: fake, bodies, urls }
}

/**
 * Narrow a resolved model to the object form.
 *
 * `ModelResolver` is declared over the SDK's `LanguageModel` union, whose other member is a bare
 * model-id string. Every resolver in this file returns the object, so this asserts that rather
 * than casting past it: a resolver that started handing back a string would fail here instead of
 * silently skipping the assertion below.
 */
function asModel(model: LanguageModel): Exclude<LanguageModel, string> {
  if (typeof model === 'string') throw new Error(`expected a model instance, got "${model}"`)
  return model
}

/**
 * Run `call` with the global `fetch` captured, for the two entry points that take no transport
 * option. Neither has one because neither needs one in production; stubbing the global is what
 * keeps the wire assertion available without widening a production signature for a test.
 */
async function onTheWire(call: () => PromiseLike<unknown>): Promise<Record<string, unknown>[]> {
  const captured = capturingFetch()
  vi.stubGlobal('fetch', captured.fetch)
  try {
    await expect(call()).rejects.toThrow(/captured-by-injected-fetch/)
  } finally {
    vi.unstubAllGlobals()
  }
  return captured.bodies
}

describe('openAiCompatibleResolver', () => {
  // SEC-2: the inline model-provider path wires a redirect-revalidating `fetchLocalRunner` as the
  // resolver's `fetch` for local runner endpoints, so a permitted local host can't 302 an inline
  // LLM call to the cloud-metadata endpoint. This asserts the plumbing that makes that possible:
  // an injected `fetch` is the transport the SDK actually calls. (The redirect refusal itself is
  // covered by `fetchLocalRunner`'s own tests.)
  it('routes model calls through an injected fetch', async () => {
    const seen: string[] = []
    const fakeFetch = vi.fn(async (url: unknown) => {
      seen.push(String(url))
      // Stand in for `fetchLocalRunner` refusing a hop — the SDK surfaces the rejection.
      throw new Error('blocked-by-injected-fetch')
    }) as unknown as typeof fetch

    const resolve = openAiCompatibleResolver({
      name: 'ollama',
      apiKey: 'local',
      baseURL: 'http://localhost:11434/v1',
      fetch: fakeFetch,
    })
    const model = resolve({ provider: 'ollama', model: 'llama3' })

    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow(
      /blocked-by-injected-fetch/,
    )
    expect(fakeFetch).toHaveBeenCalled()
    expect(seen[0]).toContain('http://localhost:11434/v1')
  })

  // The whole reason the flag is threaded through: WITHOUT it the SDK rewrites a schema-carrying
  // request to `{ type: 'json_object' }` and DROPS the schema, recording only a warning nothing
  // in this repo reads. Both halves are pinned, so a future default flip is visible here rather
  // than in a reviewer's unenforced schema.
  it('sends a json_schema response format only when structured outputs are declared supported', async () => {
    const responseFormat = {
      type: 'json',
      schema: { type: 'object', properties: { verdict: { type: 'string' } } },
      name: 'verdict',
    } satisfies LanguageModelV3CallOptions['responseFormat']

    const declared = capturingFetch()
    await expect(
      asModel(
        openAiCompatibleResolver({
          name: 'qwen',
          apiKey: 'k',
          baseURL: 'https://vendor.test/v1',
          fetch: declared.fetch,
          supportsStructuredOutputs: true,
        })({ provider: 'qwen', model: 'qwen-max' }),
      ).doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        responseFormat,
      }),
    ).rejects.toThrow(/captured-by-injected-fetch/)
    expect(declared.bodies[0]?.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { schema: responseFormat.schema, name: 'verdict' },
    })

    const undeclared = capturingFetch()
    await expect(
      asModel(
        openAiCompatibleResolver({
          name: 'ollama',
          apiKey: 'local',
          baseURL: 'http://localhost:11434/v1',
          fetch: undeclared.fetch,
        })({ provider: 'ollama', model: 'llama3' }),
      ).doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        responseFormat,
      }),
    ).rejects.toThrow(/captured-by-injected-fetch/)
    expect(undeclared.bodies[0]?.response_format).toEqual({ type: 'json_object' })
  })
})

describe('openRouterResolver', () => {
  it('asks for usage accounting and parameter-aware routing on every call', async () => {
    const captured = capturingFetch()
    const model = openRouterResolver({ apiKey: 'k', fetch: captured.fetch })({
      provider: 'openrouter',
      model: 'anthropic/claude-opus-5',
    })

    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow(
      /captured-by-injected-fetch/,
    )

    expect(captured.urls[0]).toContain('https://openrouter.ai/api/v1')
    const body = captured.bodies[0] ?? {}
    expect(body.model).toBe('anthropic/claude-opus-5')
    // `usage.include` is what makes the reply carry the gateway's own cost and the upstream that
    // served it. Without it every OpenRouter row falls back to a price-table estimate, which is
    // the state this resolver exists to end.
    expect(body.usage).toEqual({ include: true })
    expect(body.provider).toMatchObject({ require_parameters: true, data_collection: 'deny' })
  })

  it('denies prompt-retaining upstreams unless the deployment opts in', async () => {
    const denied = capturingFetch()
    await expect(
      generateText({
        model: openRouterResolver({ apiKey: 'k', fetch: denied.fetch })({
          provider: 'openrouter',
          model: 'x/y',
        }),
        prompt: 'hi',
        maxRetries: 0,
      }),
    ).rejects.toThrow(/captured-by-injected-fetch/)
    expect((denied.bodies[0]?.provider as { data_collection?: string })?.data_collection).toBe(
      'deny',
    )

    const allowed = capturingFetch()
    await expect(
      generateText({
        model: openRouterResolver({
          apiKey: 'k',
          routing: { dataCollection: 'allow', requireParameters: true },
          fetch: allowed.fetch,
        })({ provider: 'openrouter', model: 'x/y' }),
        prompt: 'hi',
        maxRetries: 0,
      }),
    ).rejects.toThrow(/captured-by-injected-fetch/)
    expect((allowed.bodies[0]?.provider as { data_collection?: string })?.data_collection).toBe(
      'allow',
    )
  })

  it('lets a deployment drop the parameter requirement', async () => {
    // The pool `require_parameters` can empty has to be reachable from a deployment's config, or
    // an operator whose model is served only by upstreams advertising a subset has no move left
    // but a fork. Same reasoning as `data_collection`, opposite default.
    const captured = capturingFetch()
    await expect(
      generateText({
        model: openRouterResolver({
          apiKey: 'k',
          routing: { dataCollection: 'deny', requireParameters: false },
          fetch: captured.fetch,
        })({ provider: 'openrouter', model: 'x/y' }),
        prompt: 'hi',
        maxRetries: 0,
      }),
    ).rejects.toThrow(/captured-by-injected-fetch/)
    expect(
      (captured.bodies[0]?.provider as { require_parameters?: boolean })?.require_parameters,
    ).toBe(false)
  })

  it('leaves structured-output strictness on the client default', async () => {
    // The client already defaults `strict` to true, so pinning it here would read as an opt-in
    // that must not be removed while changing nothing. What matters is that the request still
    // carries the schema rather than being downgraded to `json_object`, which is the generic
    // client's failure mode and the reason this gateway has its own resolver.
    const captured = capturingFetch()
    await expect(
      generateText({
        model: openRouterResolver({ apiKey: 'k', fetch: captured.fetch })({
          provider: 'openrouter',
          model: 'x/y',
        }),
        prompt: 'hi',
        maxRetries: 0,
      }),
    ).rejects.toThrow(/captured-by-injected-fetch/)
    expect(captured.bodies[0]).not.toHaveProperty('structuredOutputs')
  })

  it('honours a deployment base-URL override', async () => {
    const captured = capturingFetch()
    await expect(
      generateText({
        model: openRouterResolver({
          apiKey: 'k',
          baseURL: 'https://gateway.internal/api/v1',
          fetch: captured.fetch,
        })({ provider: 'openrouter', model: 'x/y' }),
        prompt: 'hi',
        maxRetries: 0,
      }),
    ).rejects.toThrow(/captured-by-injected-fetch/)
    expect(captured.urls[0]).toContain('https://gateway.internal/api/v1')
  })
})

describe('directOpenAiCompatibleResolver', () => {
  // The dispatch BOTH entry points share (`baseProviderRegistry` and the server's
  // `buildDirectResolver`). A call site that quietly took the generic client would still work,
  // just with no reported cost and no upstream name, so the two clients are told apart by the
  // identity the SDK stamps on the model rather than by anything observable downstream.
  it('gives openrouter the gateway client and every other provider the generic one', () => {
    const gateway = asModel(
      directOpenAiCompatibleResolver('openrouter', 'k', {
        baseURL: 'https://openrouter.ai/api/v1',
      })({ provider: 'openrouter', model: 'a/b' }),
    )
    expect(gateway.provider).toBe('openrouter')

    const generic = asModel(
      directOpenAiCompatibleResolver('qwen', 'k', {
        baseURL: 'https://vendor.test/v1',
      })({ provider: 'qwen', model: 'qwen-max' }),
    )
    expect(generic.provider).toBe('qwen.chat')
  })

  // The claim is per PROVIDER, so it cannot be walked back per model, and it is wrong in the
  // direction that HARD-fails: a cloud vendor serves `json_schema`, while an operator-hosted
  // gateway serves whatever its own config points at, routinely an Ollama or vLLM model that
  // answers a schema-carrying request with a 400. Withholding it there keeps the SDK's silent
  // downgrade, which is the behaviour those two deployments already had.
  it('claims json_schema for a cloud vendor and withholds it from an operator-hosted gateway', async () => {
    const responseFormat = {
      type: 'json',
      schema: { type: 'object', properties: { verdict: { type: 'string' } } },
      name: 'verdict',
    } satisfies LanguageModelV3CallOptions['responseFormat']
    const responseFormatFor = async (provider: string) => {
      const bodies = await onTheWire(() =>
        asModel(
          directOpenAiCompatibleResolver(provider, 'k', {
            baseURL: 'https://vendor.test/v1',
          })({ provider, model: 'm' }),
        ).doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          responseFormat,
        }),
      )
      return bodies[0]?.response_format
    }

    for (const vendor of ['qwen', 'deepseek', 'moonshot', 'openai', 'xai']) {
      expect(await responseFormatFor(vendor)).toMatchObject({ type: 'json_schema' })
    }
    for (const gateway of ['bifrost', 'litellm']) {
      expect(await responseFormatFor(gateway)).toEqual({ type: 'json_object' })
    }
  })

  it('passes the deployment routing through to the gateway client', async () => {
    const bodies = await onTheWire(() =>
      generateText({
        model: directOpenAiCompatibleResolver('openrouter', 'k', {
          baseURL: 'https://openrouter.ai/api/v1',
          openRouterRouting: { dataCollection: 'allow', requireParameters: false },
        })({ provider: 'openrouter', model: 'a/b' }),
        prompt: 'hi',
        maxRetries: 0,
      }),
    )
    expect(bodies[0]?.provider).toMatchObject({
      data_collection: 'allow',
      require_parameters: false,
    })
  })
})

describe('baseProviderRegistry', () => {
  // The exported deployment-level seam. Nothing in this repo calls it (both facades go through
  // the server's `buildDirectResolver`), which is exactly why it is exercised here: an option
  // that is never threaded and never asserted is one that silently stops being threaded, and the
  // symptom would be a host's OpenRouter calls quietly reverting to the platform default.
  it('routes its OpenAI-compatible providers through the same dispatch, routing and all', async () => {
    const registry = baseProviderRegistry({
      openAiCompatible: {
        openrouter: { apiKey: 'k', baseURL: 'https://openrouter.ai/api/v1' },
        qwen: { apiKey: 'k', baseURL: 'https://vendor.test/v1' },
        // No key: not registered at all, so a call for it fails as "unsupported model provider"
        // rather than reaching the vendor with an empty bearer.
        deepseek: { baseURL: 'https://api.deepseek.com' },
      },
      openRouterRouting: { dataCollection: 'allow', requireParameters: false },
    })
    expect(Object.keys(registry).filter((provider) => registry[provider])).toEqual([
      'openrouter',
      'qwen',
    ])

    const resolveOpenRouter = registry.openrouter
    if (!resolveOpenRouter) throw new Error('expected an openrouter resolver')
    const bodies = await onTheWire(() =>
      generateText({
        model: resolveOpenRouter({ provider: 'openrouter', model: 'a/b' }),
        prompt: 'hi',
        maxRetries: 0,
      }),
    )
    expect(bodies[0]?.usage).toEqual({ include: true })
    expect(bodies[0]?.provider).toMatchObject({
      data_collection: 'allow',
      require_parameters: false,
    })
  })
})
