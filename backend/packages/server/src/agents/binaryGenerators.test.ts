import type { AgentRunContext, ToolSecretResolver, ToolSecretSubject } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { resolveBinaryGeneratorSecrets } from './binaryGenerators.js'

// The credentials of a step's generative binary integrations, for one container dispatch. What
// these pin is the contract the feature rests on: the VALUES leave through the job body alone,
// a key that does not resolve degrades to a stated absence rather than a failed dispatch, and the
// resolver is told WHICH KIND of subject it is answering for.

function context(generators: AgentRunContext['binaryGenerators']): AgentRunContext {
  return {
    agentKind: 'image-generator',
    pipelineName: 'p',
    binaryGenerators: generators,
  } as unknown as AgentRunContext
}

function recordingResolver(values: Record<string, string>): {
  resolver: ToolSecretResolver
  subjects: ToolSecretSubject[]
} {
  const subjects: ToolSecretSubject[] = []
  return {
    subjects,
    resolver: {
      resolve: async ({ subject, keys }) => {
        subjects.push(subject)
        return Object.fromEntries(
          keys.map((k) => [k.key, values[k.key]]).filter(([, v]) => v),
        ) as Record<string, string>
      },
    },
  }
}

describe('resolveBinaryGeneratorSecrets', () => {
  const retro = {
    id: 'retro-diffusion',
    label: 'Retro Diffusion',
    modalities: ['image' as const],
    credentialKey: 'RD_TOKEN',
  }

  it('resolves each declared credential into a job-body env pair', async () => {
    const { resolver, subjects } = recordingResolver({ RD_TOKEN: 'tok' })
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([retro]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
      }),
    ).toEqual([{ key: 'RD_TOKEN', value: 'tok' }])
    // The subject is what keeps a per-workspace resolver from confusing a generative integration
    // with a tool server of the same id.
    expect(subjects).toEqual([{ kind: 'binary-generator', id: 'retro-diffusion' }])
  })

  it('degrades an unresolvable credential to an absence, never a failed dispatch', async () => {
    // The brief already tells the agent that an unset variable means the platform could not
    // provide the key, and to report it. A run that generates what it can and names the gap beats
    // one that refuses to start over the most ordinary misconfiguration there is.
    const logger = createRecordingLogger()
    const { resolver } = recordingResolver({})
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([retro]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
        logger,
      }),
    ).toEqual([])
    expect(logger.lines.some((line) => line.msg.includes('did not resolve'))).toBe(true)
  })

  it('never throws when the resolver does — a broken store costs the credential, not the run', async () => {
    const broken: ToolSecretResolver = {
      resolve: async () => {
        throw new Error('secret store unreachable')
      },
    }
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([retro]),
        workspaceId: 'ws1',
        resolveToolSecrets: broken,
        logger: createRecordingLogger(),
      }),
    ).toEqual([])
  })

  it('asks once per KEY, so two integrations sharing one variable cannot fight over it', async () => {
    const { resolver, subjects } = recordingResolver({ RD_TOKEN: 'tok' })
    const secrets = await resolveBinaryGeneratorSecrets({
      context: context([
        retro,
        {
          id: 'retro-music',
          label: 'Retro Music',
          modalities: ['audio'],
          credentialKey: 'RD_TOKEN',
        },
      ]),
      workspaceId: 'ws1',
      resolveToolSecrets: resolver,
    })
    expect(secrets).toEqual([{ key: 'RD_TOKEN', value: 'tok' }])
    expect(subjects).toHaveLength(1)
  })

  it('resolves nothing for a step with no integrations, or an integration with no credential', async () => {
    const { resolver, subjects } = recordingResolver({ RD_TOKEN: 'tok' })
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
      }),
    ).toEqual([])
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([{ id: 'open-gen', label: 'Open', modalities: ['image'] }]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
      }),
    ).toEqual([])
    expect(subjects).toEqual([])
  })

  it('resolves nothing when the facade wires no secret resolver at all', async () => {
    expect(
      await resolveBinaryGeneratorSecrets({ context: context([retro]), workspaceId: 'ws1' }),
    ).toEqual([])
  })
})
