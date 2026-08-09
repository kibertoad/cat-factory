import { describe, expect, it } from 'vitest'
import {
  PLATFORM_RESERVED_ENV_KEYS,
  PLATFORM_RESERVED_ENV_PREFIXES,
  isReservedPlatformEnvKey,
  isToolchainEnvName,
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

describe('isToolchainEnvName', () => {
  // The rule for the OTHER name a credential has. It binds the INJECTION name, which reads
  // nothing, so it is narrower than the reserved floor on purpose: a value set as `PATH`
  // reconfigures the process, while one set as `GITHUB_PERSONAL_ACCESS_TOKEN` is exactly what the
  // GitHub MCP server needs.
  it('names the variables that reconfigure a process rather than authenticate a call', () => {
    expect(isToolchainEnvName('PATH')).toBe(true)
    expect(isToolchainEnvName('LD_PRELOAD')).toBe(true)
    expect(isToolchainEnvName('npm_config_registry')).toBe(true)
    expect(isToolchainEnvName('GIT_SSH_COMMAND')).toBe(true)
  })

  it('leaves a vendor variable inside a reserved platform FAMILY alone', () => {
    // The whole point of the split: `GITHUB_` is reserved as a lookup key because the platform
    // reads `GITHUB_APP_ID` and friends, but nothing reads this one, and the GitHub MCP server's
    // client requires exactly this name.
    expect(isToolchainEnvName('GITHUB_PERSONAL_ACCESS_TOKEN')).toBe(false)
    expect(isToolchainEnvName('SLACK_BOT_TOKEN')).toBe(false)
    expect(isToolchainEnvName('AWS_ACCESS_KEY_ID')).toBe(false)
    // …and each of those IS still refused as a lookup key, which is the half that protects the
    // deployment's environment.
    expect(isReservedPlatformEnvKey('GITHUB_PERSONAL_ACCESS_TOKEN')).toBe(true)
    expect(isReservedPlatformEnvKey('SLACK_BOT_TOKEN')).toBe(true)
  })
})

describe('the generative-integration credential schema', () => {
  const definition = (key: string) => ({
    id: 'acme-images',
    name: 'Acme Images',
    summary: 'Generates images',
    description: '',
    modalities: ['image'],
    credentials: [{ key }],
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

  it('accepts an injection name inside a reserved FAMILY, which is the escape the floor needs', () => {
    expect(
      binaryGeneratorDefinitionIssues({
        ...definition('ACME_IMAGE_API_KEY'),
        credentials: [{ key: 'ACME_IMAGE_API_KEY', envName: 'GITHUB_MODELS_TOKEN' }],
      }),
    ).toEqual([])
  })

  it('refuses a TOOLCHAIN injection name, which would reconfigure the agent’s process', () => {
    const issues = binaryGeneratorDefinitionIssues({
      ...definition('ACME_IMAGE_API_KEY'),
      credentials: [{ key: 'ACME_IMAGE_API_KEY', envName: 'PATH' }],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('toolchain environment variable')
  })

  it('holds EVERY credential in the list to the floor, not just the first', () => {
    // The list is what an integration authenticating with a PAIR declares, and a rule that only
    // read `[0]` would leave the second half as the way around a floor whose whole job is to keep
    // the deployment's own configuration out of an agent process.
    const issues = binaryGeneratorDefinitionIssues({
      ...definition('ACME_IMAGE_API_KEY'),
      credentials: [{ key: 'ACME_IMAGE_API_KEY' }, { key: 'ENCRYPTION_KEY' }],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain(reservedEnvKeyMessage('ENCRYPTION_KEY'))
  })

  it('accepts the PAIR this list exists for: two names, two values, one integration', () => {
    expect(
      binaryGeneratorDefinitionIssues({
        ...definition('SCENARIO_API_KEY'),
        credentials: [
          { key: 'SCENARIO_API_KEY', usage: 'the HTTP Basic username' },
          { key: 'SCENARIO_API_SECRET', usage: 'the HTTP Basic password' },
        ],
      }),
    ).toEqual([])
  })
})
