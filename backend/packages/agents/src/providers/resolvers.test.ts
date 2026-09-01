import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'
import { generateText, type LanguageModel } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import {
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
        model: openRouterResolver({ apiKey: 'k', dataCollection: 'allow', fetch: allowed.fetch })({
          provider: 'openrouter',
          model: 'x/y',
        }),
        prompt: 'hi',
        maxRetries: 0,
      }),
    ).rejects.toThrow(/captured-by-injected-fetch/)
    expect((allowed.bodies[0]?.provider as { data_collection?: string })?.data_collection).toBe(
      'allow',
    )
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
})
