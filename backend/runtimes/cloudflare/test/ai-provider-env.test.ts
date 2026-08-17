import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URLS,
  OPENAI_COMPATIBLE_PROVIDERS,
  OPERATOR_HOSTED_GATEWAYS,
  UI_CONFIGURABLE_DIRECT_PROVIDERS,
} from '@cat-factory/agents'
import { createRecordingLogger } from '@cat-factory/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import {
  baseUrlFor,
  resolveOpenAiCompatibleUpstream,
} from '../src/infrastructure/ai/providerEndpoints'
import {
  bedrockModelsCapability,
  clearModelRegistries,
  registerModelRegistry,
} from '../src/infrastructure/ai/registries'
import type { Env } from '../src/infrastructure/env'

// The Worker's env → AI-provider wiring: which `Env` fields decide what this deployment can serve.
//
// Both halves live in ONE file on purpose. Every test file in this package runs inside workerd and
// applies five D1 migration lineages in `test/apply-migrations.ts` before its first assertion, and
// there is no cheaper lane here (the pool is configured package-wide, with no `include` split). So
// pure env-mapping assertions share a file rather than each buying that setup again; keep new ones
// here rather than adding a third.

// ---------------------------------------------------------------------------
// Base-URL overrides.
//
// The override map inside `baseUrlFor` is TOTAL over the shared `DirectProvider` union, so a
// provider MISSING from it is already a type error. What no typecheck can see is a member wired to
// the WRONG `Env` field, since every one of them is `string | undefined`. That is what these
// assert: each provider's own `${PROVIDER}_BASE_URL` reaches it and nothing else does.
// ---------------------------------------------------------------------------

const OVERRIDE = 'https://override.internal/v1'

/**
 * An `Env` carrying only the named vars. The double hop is needed because the keys are COMPUTED
 * from a provider id (`${provider}_BASE_URL`), which types the literal as a string index signature
 * and so overlaps `Env` nowhere; the whole point of these cases is that the key is derived from the
 * provider rather than written out, which is what makes a mis-wired field visible.
 */
const envWith = (vars: Record<string, string>): Env => vars as unknown as Env

describe('the Worker baseUrlFor env map', () => {
  it('reads each direct provider from its own ${PROVIDER}_BASE_URL field and no other', () => {
    // Over the DIRECT providers, not just the OpenAI-compatible ones: `anthropic` is the member
    // this map used to omit, which made `ANTHROPIC_BASE_URL` a variable Node honoured and the
    // Worker silently ignored on the same deployment config.
    for (const provider of UI_CONFIGURABLE_DIRECT_PROVIDERS) {
      const own = `${provider.toUpperCase()}_BASE_URL`
      expect(baseUrlFor(provider, envWith({ [own]: OVERRIDE }))).toBe(OVERRIDE)

      // Every OTHER provider's env field must leave this one on its own default (or, for a
      // provider with no built-in endpoint, on null): a mis-wired entry shows up here as one
      // provider reacting to a sibling's variable.
      for (const other of UI_CONFIGURABLE_DIRECT_PROVIDERS) {
        if (other === provider) continue
        const sibling = `${other.toUpperCase()}_BASE_URL`
        expect(baseUrlFor(provider, envWith({ [sibling]: OVERRIDE }))).toBe(
          DEFAULT_OPENAI_COMPATIBLE_BASE_URLS[provider] ?? null,
        )
      }
    }
  })

  it('answers null for an operator-hosted gateway until its base URL is set', () => {
    for (const provider of OPERATOR_HOSTED_GATEWAYS) {
      expect(baseUrlFor(provider, {} as Env)).toBeNull()
      // A blank value falls back to the (absent) default rather than an empty URL.
      expect(
        baseUrlFor(provider, envWith({ [`${provider.toUpperCase()}_BASE_URL`]: '  ' })),
      ).toBeNull()
    }
  })

  it('answers null for a provider that carries no base URL of its own', () => {
    // `anthropic` resolves nothing until overridden (its SDK holds the default), and `workers-ai`
    // is reached through the `AI` binding, so neither has an entry in the defaults table.
    expect(baseUrlFor('anthropic', {} as Env)).toBeNull()
    expect(baseUrlFor('workers-ai', {} as Env)).toBeNull()
  })
})

describe('the Worker OpenAI-compatible proxy upstream', () => {
  it('forwards every OpenAI-compatible provider that resolves a base URL', () => {
    const env = envWith(
      Object.fromEntries(
        OPERATOR_HOSTED_GATEWAYS.map((provider) => [
          `${provider.toUpperCase()}_BASE_URL`,
          OVERRIDE,
        ]),
      ),
    )
    for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
      expect(resolveOpenAiCompatibleUpstream(provider, env)).toEqual({
        baseURL: DEFAULT_OPENAI_COMPATIBLE_BASE_URLS[provider] ?? OVERRIDE,
      })
    }
  })

  it('refuses anthropic even once ANTHROPIC_BASE_URL resolves', () => {
    // The membership test is the shared table's predicate, NOT "did a base URL resolve". Now that
    // the override IS wired, those two answers differ for `anthropic`, and forwarding it down the
    // OpenAI-shaped path would post a body an Anthropic endpoint rejects.
    const env = { ANTHROPIC_BASE_URL: 'https://anthropic.internal/v1' } as Env
    expect(baseUrlFor('anthropic', env)).toBe('https://anthropic.internal/v1')
    expect(resolveOpenAiCompatibleUpstream('anthropic', env)).toBeNull()
  })

  it('refuses workers-ai, which this facade serves in-process through the AI binding', () => {
    expect(resolveOpenAiCompatibleUpstream('workers-ai', {} as Env)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Bedrock enablement.
//
// The Worker does not bundle `@cat-factory/provider-bedrock`; a deployment mixes it in via
// `registerModelRegistry`. Unlike Node, where `BEDROCK_REGION` also registers the resolver (so the
// env alone proves the route is dispatchable), the env vars here prove nothing: the capability must
// stay off until a registered registry can serve `provider: 'bedrock'`, or the picker would offer
// rows whose dispatch fails on an unregistered provider.
// ---------------------------------------------------------------------------

const bedrockEnv = {
  BEDROCK_REGION: 'eu-central-1',
  BEDROCK_MODELS: 'eu.anthropic.claude-opus-4-8, openai.gpt-5.5',
} as Env

const neverResolves = () => {
  throw new Error('these tests never resolve a model')
}

afterEach(() => clearModelRegistries())

describe('bedrockModelsCapability', () => {
  it('grants the parsed allow-list, order preserved, when a registered registry serves bedrock', () => {
    registerModelRegistry(() => ({ bedrock: neverResolves }))
    expect([...(bedrockModelsCapability(bedrockEnv) ?? [])]).toEqual([
      'eu.anthropic.claude-opus-4-8',
      'openai.gpt-5.5',
    ])
  })

  it('stays off when nothing is registered, warning once and naming the missing mix-in', () => {
    const log = createRecordingLogger()
    expect(bedrockModelsCapability(bedrockEnv, log)).toBeUndefined()
    expect(bedrockModelsCapability(bedrockEnv, log)).toBeUndefined()
    const warns = log.lines.filter((line) => line.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.msg).toContain('registerModelRegistry')
  })

  it('stays off when the registered registries serve other providers', () => {
    registerModelRegistry(() => ({ litellm: neverResolves }))
    expect(bedrockModelsCapability(bedrockEnv, createRecordingLogger())).toBeUndefined()
  })

  it('contributes nothing without BEDROCK_MODELS, registered or not', () => {
    registerModelRegistry(() => ({ bedrock: neverResolves }))
    expect(
      bedrockModelsCapability({ BEDROCK_REGION: 'eu-central-1' } as Env, createRecordingLogger()),
    ).toBeUndefined()
  })
})
