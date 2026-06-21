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
    // Environments is opt-in via ENVIRONMENTS_ENABLED (set in the bindings); the shared
    // key satisfies its credential-cipher requirement.
    expect(container.environments).toBeDefined()
  })

  it('fails loudly at config load when ENCRYPTION_KEY is unset', () => {
    expect(() =>
      buildContainer({ ...env, ENCRYPTION_KEY: undefined } as typeof env, agent()),
    ).toThrow(/ENCRYPTION_KEY is required/i)
  })
})
