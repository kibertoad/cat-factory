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
//  4. A STREAMED call's do NOT, because the resolver never asks for them. Nothing inline streams
//     today, so that is a LATENT gap rather than a live one; the test that found it carries the
//     evidence and names what the first streaming caller owes.
//  5. `supportsStructuredOutputs: false` downgrades a schema request rather than failing it.
//
// Self-skips without Docker, mirroring the executor-harness acceptance suite. It is not part of any
// default `vitest run`; see `vitest.integration.config.ts`.

const docker = dockerAvailable()

// A self-skip is right on a laptop and wrong on the runner: this lane is one of the aggregated
// `Test` gate's required jobs, and a skipped suite exits 0, so a runner whose daemon is missing or
// wedged would report the lane green having asserted nothing. In CI the absence is the failure.
if (!docker && process.env.CI) {
  throw new Error(
    'the LiteLLM gateway lane requires a Docker daemon, and `docker info` failed. In CI this is a failure rather than a skip: a skipped required lane reads as coverage it did not provide.',
  )
}

/** Where the gateway posts its upstream call, given the `api_base` the committed config sets. */
const UPSTREAM_CHAT_PATH = '/v1/chat/completions'

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

  /**
   * Watch what the stub receives from here on, so no assertion can read an older request.
   *
   * Taking a mark and reading the whole slice is what distinguishes "the gateway called the
   * upstream once" from "the gateway called nothing and the previous test's entry is still the
   * newest". It also pins that the gateway does not RETRY, which the committed config turns off
   * and nothing else in the suite would notice.
   */
  const watchUpstream = () => {
    const requestMark = upstream.requests.length
    const errorMark = upstream.errors.length
    const since = () => upstream.requests.slice(requestMark)
    return {
      all: since,
      /** The ONE chat completion the call under test provoked. */
      sole: () => {
        // A transport failure means the record may be incomplete, so it invalidates the
        // assertions built on it rather than being left for someone to notice in the log.
        expect(upstream.errors.slice(errorMark)).toEqual([])
        const calls = since()
        expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
          `POST ${UPSTREAM_CHAT_PATH}`,
        ])
        return calls[0]!
      },
    }
  }

  it('resolves the operator alias, and rewrites it to the underlying model upstream', async () => {
    upstream.reply({ content: 'routed through litellm' })
    const calls = watchUpstream()

    const result = await generateText({ model: model(), prompt: 'ping' })

    expect(result.text).toBe('routed through litellm')
    // Outbound, the alias is GONE: the upstream is asked for the model the operator's config maps
    // it to. So the id a workspace pins is meaningful only against the gateway that defines it,
    // which is why the catalog carries one generic `litellm-default` entry and enumerates nothing.
    expect(calls.sole().model).toBe(UPSTREAM_MODEL)
    // Inbound, the alias is BACK. Anything reading the served model off a reply (telemetry,
    // attribution) therefore records the operator's name for it, not the upstream's.
    expect(result.response.modelId).toBe(GATEWAY_ALIAS)
  })

  it('never shows the caller gateway key to the upstream', async () => {
    upstream.reply({ content: 'ok' })
    const calls = watchUpstream()

    await generateText({ model: model(), prompt: 'ping' })

    // The gateway substitutes its configured upstream credential. A deployment's pooled `litellm`
    // key is therefore scoped to the gateway alone and is never a vendor key in transit, which is
    // the property that makes pooling one safe.
    const call = calls.sole()
    expect(call.headers.authorization).toBe(`Bearer ${gateway.upstreamKey}`)
    // Over every header and the body, not just `authorization`: the property is that the caller's
    // key does not reach the upstream AT ALL, and a proxy that forwarded it as routing metadata
    // (its own header, or a field) would satisfy a check that reads one field.
    expect(JSON.stringify(call.headers)).not.toContain(gateway.masterKey)
    expect(call.raw).not.toContain(gateway.masterKey)
  })

  it('carries the upstream token counts through the gateway', async () => {
    upstream.reply({
      content: 'metered',
      usage: { prompt_tokens: 31, completion_tokens: 5, total_tokens: 36 },
    })
    const calls = watchUpstream()

    const result = await generateText({ model: model(), prompt: 'ping' })

    // The gateway re-emits rather than proxies bytes, so this is the assertion that says the spend
    // rollup gets real numbers off a LiteLLM deployment instead of zeroes.
    expect(calls.sole().stream).toBe(false)
    expect(result.usage.inputTokens).toBe(31)
    expect(result.usage.outputTokens).toBe(5)
  })

  it('streams a reply, but asks for no usage with it (a latent gap, pinned)', async () => {
    upstream.reply({
      content: 'streamed through litellm',
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    })
    const calls = watchUpstream()

    const result = streamText({ model: model(), prompt: 'ping' })
    let assembled = ''
    for await (const delta of result.textStream) assembled += delta

    expect(assembled).toBe('streamed through litellm')
    expect(calls.sole().stream).toBe(true)

    // READ THIS BEFORE "FIXING" THE ASSERTION BELOW.
    //
    // The stub emits a usage chunk on every stream, and LiteLLM DROPS it unless the client asked
    // for one with `stream_options: { include_usage: true }`. Verified against this image both
    // ways: with the option the final chunk carries the counts, without it no usage chunk is
    // emitted at all. `openAiCompatibleResolver` never sets the SDK's `includeUsage`, so a
    // streamed call through any OpenAI-compatible provider (both operator-hosted gateways, plus
    // qwen / deepseek / moonshot / xai and the Cloudflare REST resolver) would carry none.
    //
    // NOTHING INLINE STREAMS TODAY, which is what makes this a latent gap rather than a live
    // metering hole. The spec reaches it only by resolving a model raw; every production
    // resolution goes through `InstrumentedModelProvider`, whose `wrapStream` THROWS rather than
    // let a streamed call reach the sinks unrecorded. That refusal and this missing option are
    // halves of the same unfinished work: the first inline caller that wants to stream has to
    // implement `wrapStream`, thread `streaming` through the inline recorder, AND ask for usage,
    // or it books what it spends at zero. The evidence that the absence is an oversight rather
    // than a policy is that the CONTAINER path already sets exactly this option for the same
    // upstreams, unconditionally, so that it can meter them (`LlmProxyController.ts`,
    // `relayUpstream`). When that work lands, this assertion is the one that should flip.
    expect((await result.usage).outputTokens).toBeUndefined()
  })

  it('passes a tool definition upstream and returns the call the upstream made', async () => {
    upstream.reply({ toolCalls: [{ name: 'lookup', args: { query: 'cats' } }] })
    const calls = watchUpstream()

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

    expect(calls.sole().toolNames).toEqual(['lookup'])
    expect(result.toolCalls.map((call) => call.toolName)).toEqual(['lookup'])
    expect(result.toolCalls[0]?.input).toEqual({ query: 'cats' })
  })

  it('downgrades a schema request to json_object rather than failing it', async () => {
    upstream.reply({ content: JSON.stringify({ verdict: 'pass', score: 4 }) })
    const calls = watchUpstream()

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
    expect(calls.sole().responseFormat).toEqual({ type: 'json_object' })
    expect(result.object).toEqual({ verdict: 'pass', score: 4 })
  })

  it('refuses a wrong gateway key without reaching the upstream', async () => {
    const calls = watchUpstream()
    const wrongKey = directOpenAiCompatibleResolver('litellm', 'sk-not-the-master-key', {
      baseURL: gateway.baseUrl,
    })({ provider: 'litellm', model: GATEWAY_ALIAS })

    await expect(generateText({ model: wrongKey, prompt: 'ping' })).rejects.toThrow()

    // The refusal is what matters, and that it happens BEFORE any upstream spend. Every request
    // the stub saw is recorded, routable or not, so an empty slice means the gateway called
    // nothing rather than that it called somewhere the stub declined to write down.
    expect(calls.all()).toEqual([])
  })
})
