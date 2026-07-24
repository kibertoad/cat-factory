import { generateText } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { openAiCompatibleResolver } from './resolvers.js'

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
})
