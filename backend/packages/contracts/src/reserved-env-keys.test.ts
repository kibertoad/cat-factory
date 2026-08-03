import { describe, expect, it } from 'vitest'
import {
  PLATFORM_RESERVED_ENV_KEYS,
  PLATFORM_RESERVED_ENV_PREFIXES,
  isReservedPlatformEnvKey,
  reservedEnvKeyMessage,
} from './reserved-env-keys.js'
import { binaryGeneratorDefinitionIssues } from './binary-generators.js'

// The floor under every capability credential: a tool server's and a generative integration's
// alike. What is asserted here is the SHAPE of the rule (what it catches, and the two ways it
// could be walked around); that a newly-read platform variable is actually IN the set is
// `scripts/check-reserved-env-keys.mjs`, which reads the documented inventory.

describe('isReservedPlatformEnvKey', () => {
  it('names the platform’s own secrets', () => {
    expect(isReservedPlatformEnvKey('ENCRYPTION_KEY')).toBe(true)
    expect(isReservedPlatformEnvKey('HARNESS_SHARED_SECRET')).toBe(true)
    expect(isReservedPlatformEnvKey('DATABASE_URL')).toBe(true)
    expect(isReservedPlatformEnvKey('AUTH_SESSION_SECRET')).toBe(true)
    expect(isReservedPlatformEnvKey('LOCAL_MOTHERSHIP_TOKEN')).toBe(true)
    expect(isReservedPlatformEnvKey('GITHUB_PAT')).toBe(true)
  })

  it('reserves the MODEL-PROVIDER keys too, which is the case that looks like over-reach', () => {
    // `OPENAI_API_KEY` is billable and exfiltratable. An integration that wants to call OpenAI on
    // the deployment's account declares its own variable rather than silently inheriting the one
    // the model router spends.
    expect(isReservedPlatformEnvKey('OPENAI_API_KEY')).toBe(true)
    expect(isReservedPlatformEnvKey('ANTHROPIC_API_KEY')).toBe(true)
  })

  it('matches case-INSENSITIVELY, because `process.env` lookup does on Windows', () => {
    // A case-sensitive check would pass `encryption_key` and then resolve the real key on a
    // developer's laptop — the one bypass that costs nothing to attempt.
    expect(isReservedPlatformEnvKey('encryption_key')).toBe(true)
    expect(isReservedPlatformEnvKey('Harness_Shared_Secret')).toBe(true)
    expect(isReservedPlatformEnvKey('  ENCRYPTION_KEY  ')).toBe(true)
  })

  it('covers a whole platform prefix FAMILY, so a newly-read variable inside one is reserved on the day it is read', () => {
    expect(isReservedPlatformEnvKey('GITHUB_APP_PRIVATE_KEY')).toBe(true)
    expect(isReservedPlatformEnvKey('LOCAL_MOTHERSHIP_CREDENTIAL_DB')).toBe(true)
    expect(isReservedPlatformEnvKey('AWS_SECRET_ACCESS_KEY')).toBe(true)
    expect(isReservedPlatformEnvKey('WEB_SEARCH_BRAVE_API_KEY')).toBe(true)
  })

  it('leaves an ordinary vendor credential alone — the whole point of the env resolver', () => {
    // No prefix is MANDATED on this side: a credential's key is also the environment variable
    // name the agent reads the value from, so renaming it would break an SDK that auto-reads its
    // vendor's documented name.
    expect(isReservedPlatformEnvKey('MESHY_API_KEY')).toBe(false)
    expect(isReservedPlatformEnvKey('RETRO_DIFFUSION_API_KEY')).toBe(false)
    expect(isReservedPlatformEnvKey('ACME_IMAGE_TOKEN')).toBe(false)
    expect(isReservedPlatformEnvKey('MCP_ISSUE_TOKEN')).toBe(false)
  })

  it('answers false for an empty key rather than matching a prefix by accident', () => {
    expect(isReservedPlatformEnvKey('')).toBe(false)
    expect(isReservedPlatformEnvKey('   ')).toBe(false)
  })

  it('keeps both lists upper-case, since the sets are built by upper-casing them', () => {
    for (const key of [...PLATFORM_RESERVED_ENV_KEYS, ...PLATFORM_RESERVED_ENV_PREFIXES]) {
      expect(key).toBe(key.toUpperCase())
    }
  })
})

describe('the generative-integration credential schema', () => {
  const definition = (key: string) => ({
    id: 'acme-images',
    name: 'Acme Images',
    summary: 'Generates images',
    description: '',
    modalities: ['image'],
    credential: { key },
  })

  it('refuses a reserved key at REGISTRATION, so a deployment learns at boot', () => {
    const issues = binaryGeneratorDefinitionIssues(definition('ENCRYPTION_KEY'))
    expect(issues).toHaveLength(1)
    // The one shared sentence, so the schema issue, the boot problem and the dispatch log line
    // cannot describe the same fault three ways.
    expect(issues[0]).toContain(reservedEnvKeyMessage('ENCRYPTION_KEY'))
  })

  it('accepts an integration’s own variable', () => {
    expect(binaryGeneratorDefinitionIssues(definition('ACME_IMAGE_API_KEY'))).toEqual([])
  })
})
