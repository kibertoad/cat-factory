import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { buildContainer } from '../../src/infrastructure/container'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'

// One shared ENCRYPTION_KEY backs every integration's credential cipher
// (documents/tasks/environments/runners) — the cipher domain-separates per
// integration via its HKDF `info`, so a single master key is safe. These assertions
// pin that: the one key boots them all, and the always-on document/task integrations
// fail loudly at config load when it is missing.

const agent = () => ({ agentExecutor: new FakeAgentExecutor() })

describe('shared ENCRYPTION_KEY', () => {
  it('backs documents + tasks + environments from the one key', () => {
    // The test bindings supply a single ENCRYPTION_KEY (no per-integration keys).
    const container = buildContainer(env, agent())
    expect(container.documents).toBeDefined()
    expect(container.tasks).toBeDefined()
    // Environments assembles from the same shared key (no enable flag) — the key satisfies
    // its credential-cipher requirement, so it's on wherever documents/tasks are.
    expect(container.environments).toBeDefined()
  })

  it('fails loudly at config load when ENCRYPTION_KEY is unset', () => {
    expect(() =>
      buildContainer({ ...env, ENCRYPTION_KEY: undefined } as typeof env, agent()),
    ).toThrow(/ENCRYPTION_KEY/i)
  })

  it('fails at config load when ENCRYPTION_KEY is not valid base64', () => {
    expect(() =>
      buildContainer({ ...env, ENCRYPTION_KEY: '%%%not-base64%%%' } as typeof env, agent()),
    ).toThrow(/valid base64/)
  })

  it('fails at config load when ENCRYPTION_KEY decodes to fewer than 32 bytes', () => {
    // 16 zero bytes → 24-char base64 → a real but too-short key (would fail AES-256 later).
    const shortKey = btoa('\0'.repeat(16))
    expect(() =>
      buildContainer({ ...env, ENCRYPTION_KEY: shortKey } as typeof env, agent()),
    ).toThrow(/at least 32 bytes/)
  })
})

describe('primary DB binding', () => {
  it('fails loudly at container build when the DB binding is unbound', () => {
    // Otherwise `const db = env.DB` is undefined and the first repository call NPEs deep in a
    // request rather than serving the misconfiguration screen at boot.
    expect(() =>
      buildContainer({ ...env, DB: undefined } as unknown as typeof env, agent()),
    ).toThrow(/\bDB\b/)
  })
})
