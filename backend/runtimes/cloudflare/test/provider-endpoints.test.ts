import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URLS,
  OPENAI_COMPATIBLE_PROVIDERS,
  OPERATOR_HOSTED_GATEWAYS,
} from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { baseUrlFor } from '../src/infrastructure/ai/providerEndpoints'
import type { Env } from '../src/infrastructure/env'

// The Worker's env plumbing for the shared OpenAI-compatible provider table. The map inside
// `baseUrlFor` is TOTAL over `OpenAiCompatibleProvider`, so a provider MISSING from it is already a
// type error — what no typecheck can see is a member wired to the WRONG `Env` field, since every
// one of them is `string | undefined`. That is what these assert: each provider's own
// `${PROVIDER}_BASE_URL` reaches it and nothing else does.

const OVERRIDE = 'https://override.internal/v1'

describe('the Worker baseUrlFor env map', () => {
  it('reads each provider from its own ${PROVIDER}_BASE_URL field and no other', () => {
    for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
      const own = `${provider.toUpperCase()}_BASE_URL`
      expect(baseUrlFor(provider, { [own]: OVERRIDE } as Env)).toBe(OVERRIDE)

      // Every OTHER provider's env field must leave this one on its own default (or, for an
      // endpoint-less gateway, on null): a mis-wired entry shows up here as one provider reacting
      // to a sibling's variable.
      for (const other of OPENAI_COMPATIBLE_PROVIDERS) {
        if (other === provider) continue
        const sibling = `${other.toUpperCase()}_BASE_URL`
        expect(baseUrlFor(provider, { [sibling]: OVERRIDE } as Env)).toBe(
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
        baseUrlFor(provider, { [`${provider.toUpperCase()}_BASE_URL`]: '  ' } as Env),
      ).toBeNull()
    }
  })

  it('answers null for a provider that is not OpenAI-shaped', () => {
    expect(baseUrlFor('anthropic', {} as Env)).toBeNull()
    expect(baseUrlFor('workers-ai', {} as Env)).toBeNull()
  })
})
