import type { ProjectDefinition } from '@cat-factory/contracts'
import { CapabilityCredentialMissingError, type ToolSecretResolver } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { resolveProjectCredentials } from './projectJobBody.js'

function definition(credentials: ProjectDefinition['credentials']): ProjectDefinition {
  return {
    kind: 'research',
    key: 'acme:vendor',
    version: 1,
    title: 'Vendor',
    spec: {},
    credentials,
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
    inputs: [],
    promptAdditions: {},
  }
}

function resolver(values: Record<string, string>, seen: unknown[] = []): ToolSecretResolver {
  return {
    resolve: async (input) => {
      seen.push(input)
      const found: Record<string, string> = {}
      for (const { key } of input.keys) if (values[key]) found[key] = values[key]
      return found
    },
  }
}

describe('resolveProjectCredentials', () => {
  it('resolves the definition keys as its own subject and drops the unresolved optional ones', async () => {
    const seen: unknown[] = []
    const resolved = await resolveProjectCredentials(
      definition([
        { key: 'VENDOR_TOKEN', kind: 'api-token', label: 'Token', requiredAtStart: true },
        { key: 'VENDOR_LOGIN', kind: 'login', label: 'Login', requiredAtStart: false },
      ]),
      { workspaceId: 'ws_1', resolver: resolver({ VENDOR_TOKEN: 'tok' }, seen) },
    )
    expect(resolved).toEqual([{ key: 'VENDOR_TOKEN', kind: 'api-token', value: 'tok' }])
    expect(seen).toEqual([
      expect.objectContaining({
        workspaceId: 'ws_1',
        subject: { kind: 'project-definition', id: 'research/acme:vendor' },
      }),
    ])
  })

  it('refuses the dispatch when a credential needed at start does not resolve', async () => {
    const attempt = resolveProjectCredentials(
      definition([
        {
          key: 'VENDOR_TOKEN',
          kind: 'api-token',
          label: 'Token',
          onboarding: { instructions: 'Create one under Settings.' },
          requiredAtStart: true,
        },
      ]),
      { workspaceId: 'ws_1', resolver: resolver({}) },
    )
    await expect(attempt).rejects.toBeInstanceOf(CapabilityCredentialMissingError)
    await expect(attempt).rejects.toMatchObject({
      missing: {
        key: 'VENDOR_TOKEN',
        declaredBy: { kind: 'project-definition', id: 'research/acme:vendor' },
        onboarding: { instructions: 'Create one under Settings.' },
      },
    })
  })

  it('never sends a key in the reserved platform set', async () => {
    const seen: unknown[] = []
    const resolved = await resolveProjectCredentials(
      definition([{ key: 'DATABASE_URL', kind: 'secret', label: 'DB', requiredAtStart: true }]),
      { workspaceId: 'ws_1', resolver: resolver({ DATABASE_URL: 'postgres://x' }, seen) },
    )
    expect(resolved).toEqual([])
    expect(seen).toEqual([])
  })
})
