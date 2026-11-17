import type { ProjectDefinition } from '@cat-factory/contracts'
import { CapabilityCredentialMissingError, type ToolSecretResolver } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import type { AgentRunContext } from '@cat-factory/kernel'
import { buildProjectJobBody, resolveProjectCredentials } from './projectJobBody.js'

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
    stages: [],
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

describe('buildProjectJobBody', () => {
  it('materialises what the task reads and points the prompt at it, for any project kind', async () => {
    const context = {
      agentKind: 'project-researcher',
      block: {
        id: 'task_1',
        title: 'Deepen',
        description: 'Deepen the research.',
        contextProjects: [
          {
            projectId: 'prj_1',
            title: 'Stage Discover',
            kind: 'research',
            summary: 'Uses OAuth.',
            coverage: '1 of 1 questions answered',
            body: 'The scheme is OAuth client credentials.',
            revision: { id: 'pout_1', seq: 1 },
          },
        ],
      },
      project: {
        projectId: 'prj_1',
        kind: 'research',
        definition: definition([]),
        inputs: {},
        linkedFrameBlockIds: [],
        upstream: [],
        brief: { mode: 'initial', brief: 'Learn.', questions: [], priorFindings: [] },
      },
    } as unknown as AgentRunContext
    const { body } = await buildProjectJobBody(
      context,
      { workspaceId: 'ws_1', executionId: 'exec_1', jobId: 'job_1' },
      {
        agentKindRegistry: defaultAgentKindRegistry(),
        mintInstallationToken: async () => 'token',
        resolveRepoOrigin: () => {
          throw new Error('no repo is linked')
        },
        resolveModel: async () => ({ model: 'm', provider: 'p' }),
        resolveAuth: async () => ({ auth: {} }),
        resolveToolServers: async () => ({
          toolServers: [],
          unavailableToolServers: [],
          mcpServers: [],
        }),
      },
    )
    const files = body.contextFiles as { path: string; content: string }[]
    expect(files.map((f) => f.path)).toEqual(['project-stage-discover.md'])
    expect(files[0]!.content).toContain('The scheme is OAuth client credentials.')
    expect(body.userPrompt).toContain(
      '- Stage Discover (research project, revision 1): Uses OAuth.',
    )
  })
})
