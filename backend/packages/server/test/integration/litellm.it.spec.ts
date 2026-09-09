import { directOpenAiCompatibleResolver } from '@cat-factory/agents'
import { generateObject, generateText, jsonSchema, streamText, tool } from 'ai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  dockerAvailable,
  GATEWAY_ALIAS,
  type LiteLlmGateway,
  LITELLM_IMAGE,
  startLiteLlmGateway,
  startUpstreamStub,
  type UpstreamStub,
  UPSTREAM_MODEL,
} from './litellm-gateway.js'

// The LiteLLM gateway integration lane: our own `litellm` resolver, over real HTTP, against a REAL
// LiteLLM proxy running in Docker, which in turn calls a canned OpenAI-compatible upstream on the
// host. No provider key, no tokens billed.
//
// `litellm` is an OPERATOR-HOSTED gateway: it has no public endpoint, so every unit test around it
// can only assert table-derived facts (that it resolves to no default base URL, that it is
// withheld from `supportsStructuredOutputs`, that a pooled key alone leaves it unselectable). The
// five things below are invisible to all of them, because each needs a real instance in the middle:
//
//  1. The alias is resolved in BOTH directions, and differently at each end.
//  2. The caller's gateway key is swapped for the upstream's before the upstream is called.
//  3. A BUFFERED call's token counts survive the hop, which is what the spend rollup reads.
//  4. A STREAMED call's do NOT, because the inline resolver never asks for them. Pinned as a gap,
//     with the evidence, on the test that found it.
//  5. `supportsStructuredOutputs: false` downgrades a schema request rather than failing it.
//
// Self-skips without Docker, mirroring the executor-harness acceptance suite. It is not part of any
// default `vitest run`; see `vitest.integration.config.ts`.

const docker = dockerAvailable()

describe.skipIf(!docker)(`litellm gateway (${LITELLM_IMAGE})`, () => {
  let upstream: UpstreamStub
  let gateway: LiteLlmGateway

  beforeAll(async () => {
    upstream = await startUpstreamStub()
    gateway = await startLiteLlmGateway({ upstreamPort: upstream.port })
  })

  afterAll(async () => {
    gateway?.stop()
    await upstream?.close()
  })

  /** The resolver a deployment gets for a pooled `litellm` key plus `LITELLM_BASE_URL`. */
  const model = () =>
    directOpenAiCompatibleResolver('litellm', gateway.masterKey, { baseURL: gateway.baseUrl })({
      provider: 'litellm',
      model: GATEWAY_ALIAS,
    })

  /** The upstream call this test provoked. Reads the LAST, so a shared gateway cannot mislead. */
  const lastUpstreamCall = () => upstream.requests.at(-1)

  it('resolves the operator alias, and rewrites it to the underlying model upstream', async () => {
    upstream.reply({ content: 'routed through litellm' })

    const result = await generateText({ model: model(), prompt: 'ping' })

    expect(result.text).toBe('routed through litellm')
    // Outbound, the alias is GONE: the upstream is asked for the model the operator's config maps
    // it to. So the id a workspace pins is meaningful only against the gateway that defines it,
    // which is why the catalog carries one generic `litellm-default` entry and enumerates nothing.
    expect(lastUpstreamCall()?.model).toBe(UPSTREAM_MODEL)
    // Inbound, the alias is BACK. Anything reading the served model off a reply (telemetry,
    // attribution) therefore records the operator's name for it, not the upstream's.
    expect(result.response.modelId).toBe(GATEWAY_ALIAS)
  })

  it('never shows the caller gateway key to the upstream', async () => {
    upstream.reply({ content: 'ok' })

    await generateText({ model: model(), prompt: 'ping' })

    // The gateway substitutes its configured upstream credential. A deployment's pooled `litellm`
    // key is therefore scoped to the gateway alone and is never a vendor key in transit, which is
    // the property that makes pooling one safe.
    expect(lastUpstreamCall()?.authorization).toBe(`Bearer ${gateway.upstreamKey}`)
    expect(lastUpstreamCall()?.authorization).not.toContain(gateway.masterKey)
  })

  it('carries the upstream token counts through the gateway', async () => {
    upstream.reply({
      content: 'metered',
      usage: { prompt_tokens: 31, completion_tokens: 5, total_tokens: 36 },
    })

    const result = await generateText({ model: model(), prompt: 'ping' })

    // The gateway re-emits rather than proxies bytes, so this is the assertion that says the spend
    // rollup gets real numbers off a LiteLLM deployment instead of zeroes.
    expect(result.usage.inputTokens).toBe(31)
    expect(result.usage.outputTokens).toBe(5)
  })

  it('streams a reply, but reports NO usage for it (a live gap, pinned)', async () => {
    upstream.reply({
      content: 'streamed through litellm',
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    })

    const result = streamText({ model: model(), prompt: 'ping' })
    let assembled = ''
    for await (const delta of result.textStream) assembled += delta

    expect(assembled).toBe('streamed through litellm')
    expect(lastUpstreamCall()?.stream).toBe(true)

    // READ THIS BEFORE "FIXING" THE ASSERTION BELOW.
    //
    // The stub emits a usage chunk on every stream, and LiteLLM DROPS it unless the client asked
    // for one with `stream_options: { include_usage: true }`. Verified against this image both
    // ways: with the option the final chunk carries the counts, without it no usage chunk is
    // emitted at all. `openAiCompatibleResolver` never sets the SDK's `includeUsage`, so a
    // STREAMED inline call through any OpenAI-compatible provider (both operator-hosted gateways,
    // plus qwen / deepseek / moonshot / xai and the Cloudflare REST resolver) is metered at zero.
    //
    // It is pinned rather than fixed here because the fix changes production metering on seven
    // providers and this lane's remit is coverage. The evidence that it is an oversight rather
    // than a policy: the CONTAINER path already sets exactly this option for the same upstreams,
    // unconditionally, so that it can meter them (`LlmProxyController.ts`, `relayUpstream`). When
    // the inline path is brought into line, this assertion is the one that should flip.
    expect((await result.usage).outputTokens).toBeUndefined()
  })

  it('passes a tool definition upstream and returns the call the upstream made', async () => {
    upstream.reply({ toolCalls: [{ name: 'lookup', args: { query: 'cats' } }] })

    const result = await generateText({
      model: model(),
      prompt: 'look it up',
      tools: {
        lookup: tool({
          description: 'Look something up',
          inputSchema: jsonSchema<{ query: string }>({
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          }),
        }),
      },
    })

    expect(lastUpstreamCall()?.toolNames).toEqual(['lookup'])
    expect(result.toolCalls.map((call) => call.toolName)).toEqual(['lookup'])
    expect(result.toolCalls[0]?.input).toEqual({ query: 'cats' })
  })

  it('downgrades a schema request to json_object rather than failing it', async () => {
    upstream.reply({ content: JSON.stringify({ verdict: 'pass', score: 4 }) })

    const result = await generateObject({
      model: model(),
      prompt: 'judge it',
      schema: jsonSchema<{ verdict: string; score: number }>({
        type: 'object',
        properties: { verdict: { type: 'string' }, score: { type: 'number' } },
        required: ['verdict', 'score'],
      }),
    })

    // The documented consequence of withholding `supportsStructuredOutputs` from an operator-hosted
    // gateway: the SDK drops the schema and asks only for JSON. That is a DELIBERATE downgrade,
    // because what a LiteLLM alias fronts is routinely an Ollama or vLLM model that answers a
    // `json_schema` request with a 400. This pins that the downgrade actually reaches the wire, so
    // a future `supportsStructuredOutputs: true` cannot land here unnoticed.
    expect(lastUpstreamCall()?.responseFormat).toEqual({ type: 'json_object' })
    expect(result.object).toEqual({ verdict: 'pass', score: 4 })
  })

  it('refuses a wrong gateway key without reaching the upstream', async () => {
    const before = upstream.requests.length
    const wrongKey = directOpenAiCompatibleResolver('litellm', 'sk-not-the-master-key', {
      baseURL: gateway.baseUrl,
    })({ provider: 'litellm', model: GATEWAY_ALIAS })

    await expect(generateText({ model: wrongKey, prompt: 'ping' })).rejects.toThrow()

    // The refusal is what matters, and that it happens BEFORE any upstream spend.
    expect(upstream.requests.length).toBe(before)
  })
})
