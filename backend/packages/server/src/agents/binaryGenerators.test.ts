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
    credentials: [{ key: 'RD_TOKEN' }],
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

  it('resolves a PAIR into two env pairs, in ONE call for the integration', async () => {
    // An integration that authenticates with an API key and its Basic-joined secret declares two
    // credentials, and they are asked for together: the port takes a list precisely so a
    // per-workspace sealed store is asked once, and a call per credential inside a loop over the
    // list is the N+1 that shape exists to prevent.
    const { resolver, subjects } = recordingResolver({
      SCENARIO_API_KEY: 'k',
      SCENARIO_API_SECRET: 's',
    })
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([
          {
            ...retro,
            credentials: [{ key: 'SCENARIO_API_KEY' }, { key: 'SCENARIO_API_SECRET' }],
          },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
      }),
    ).toEqual([
      { key: 'SCENARIO_API_KEY', value: 'k' },
      { key: 'SCENARIO_API_SECRET', value: 's' },
    ])
    expect(subjects).toHaveLength(1)
  })

  it('lets one half of a pair fail on its own, leaving the JOINT rule to the brief', async () => {
    // Each value stands or falls by itself here, because only the agent can see what arrived and
    // the brief already tells it that a pair with a missing half must not be sent at all.
    // Collapsing the list on one failure would add a second way for a credential to disappear
    // without changing what any agent does.
    const logger = createRecordingLogger()
    const { resolver } = recordingResolver({ SCENARIO_API_KEY: 'k' })
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([
          {
            ...retro,
            credentials: [{ key: 'SCENARIO_API_KEY' }, { key: 'SCENARIO_API_SECRET' }],
          },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
        logger,
      }),
    ).toEqual([{ key: 'SCENARIO_API_KEY', value: 'k' }])
    const warned = logger.lines.filter((line) => line.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.fields?.credentialKey).toBe('SCENARIO_API_SECRET')
  })

  it('holds every credential in a list to the name floors, not just the first', async () => {
    // A floor that read only the head of the list would leave the second half as the way around
    // it, which is the whole reason both checks sit here rather than in a facade's resolver.
    const { resolver, subjects } = recordingResolver({ ACME_KEY: 'k', ENCRYPTION_KEY: 'master' })
    const logger = createRecordingLogger()
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([
          { ...retro, credentials: [{ key: 'ACME_KEY' }, { key: 'ENCRYPTION_KEY' }] },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
        logger,
      }),
    ).toEqual([{ key: 'ACME_KEY', value: 'k' }])
    expect(subjects).toHaveLength(1)
    const warned = logger.lines.filter((line) => line.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.fields?.credentialKey).toBe('ENCRYPTION_KEY')
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
    expect(
      logger.lines.some((line) => line.level === 'warn' && line.msg.includes('did not resolve')),
    ).toBe(true)
  })

  it('reports an unresolved OPTIONAL credential below warn, so it is not crying wolf', async () => {
    // `required: false` is a state the deployment DECLARED as normal — the endpoint
    // works unauthenticated, and the brief tells the agent to call it anyway. Reporting that at
    // the same severity as a required key that failed to resolve would train an operator to
    // ignore the one that actually costs a step its integration.
    const logger = createRecordingLogger()
    const { resolver } = recordingResolver({})
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([{ ...retro, credentials: [{ key: 'RD_TOKEN', required: false }] }]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
        logger,
      }),
    ).toEqual([])
    expect(logger.lines.some((line) => line.level === 'warn')).toBe(false)
    expect(
      logger.lines.some((line) => line.level === 'debug' && line.msg.includes('did not resolve')),
    ).toBe(true)
  })

  it('resolves independent keys CONCURRENTLY while keeping selection order', async () => {
    // The dedupe is decided off the projection before any lookup, so the surviving calls are
    // independent — a step holding three integrations must not pay three serial round trips to a
    // per-workspace sealed store. Order still comes from the selection, not from what returns first.
    let inFlight = 0
    let peak = 0
    const resolver: ToolSecretResolver = {
      resolve: async ({ keys }) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return Object.fromEntries(keys.map((k) => [k.key, `v-${k.key}`]))
      },
    }
    const secrets = await resolveBinaryGeneratorSecrets({
      context: context([
        retro,
        {
          id: 'studio-music',
          label: 'Studio',
          modalities: ['audio'],
          credentials: [{ key: 'STUDIO_KEY' }],
        },
        {
          id: 'reel-video',
          label: 'Reel',
          modalities: ['video'],
          credentials: [{ key: 'REEL_KEY' }],
        },
      ]),
      workspaceId: 'ws1',
      resolveToolSecrets: resolver,
    })
    expect(secrets.map((s) => s.key)).toEqual(['RD_TOKEN', 'STUDIO_KEY', 'REEL_KEY'])
    expect(peak).toBeGreaterThan(1)
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
          credentials: [{ key: 'RD_TOKEN' }],
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

  // The platform's own configuration variables are not resolvable as an integration credential.
  // The check is HERE rather than inside the env-backed default resolver so it holds whatever a
  // facade wired — and a MOTHERSHIP-MODE node needs exactly that, since it boot-validates none of
  // the definitions it resolves: they arrive per dispatch from the mothership, and the environment
  // their keys name is a developer's own laptop.
  it('refuses a reserved platform key without asking the resolver, and says so at WARN', async () => {
    const { resolver, subjects } = recordingResolver({ ENCRYPTION_KEY: 'master-key' })
    const logger = createRecordingLogger()
    const secrets = await resolveBinaryGeneratorSecrets({
      context: context([{ ...retro, credentials: [{ key: 'ENCRYPTION_KEY' }] }]),
      workspaceId: 'ws1',
      resolveToolSecrets: resolver,
      logger,
    })
    expect(secrets).toEqual([])
    expect(subjects).toEqual([])
    // WARN, not the `debug` an optional missing key gets: this is never a deployment's stated
    // normal, and its fix is a declaration rather than a variable to set.
    const warned = logger.lines.filter((line) => line.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.fields?.credentialKey).toBe('ENCRYPTION_KEY')
  })

  it('matches a reserved key case-insensitively, because `process.env` does on Windows', async () => {
    const { resolver, subjects } = recordingResolver({ harness_shared_secret: 'shh' })
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([{ ...retro, credentials: [{ key: 'harness_shared_secret' }] }]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
      }),
    ).toEqual([])
    expect(subjects).toEqual([])
  })

  // A credential has two names, and only the lookup one is a boundary. See
  // `contracts/src/reserved-env-keys.ts` for why keeping them apart is what makes both rules
  // affordable.
  it('looks the value up under `key` and injects it under `envName`', async () => {
    const { resolver } = recordingResolver({ ACME_IMAGE_TOKEN: 'tok' })
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([
          {
            ...retro,
            credentials: [{ key: 'ACME_IMAGE_TOKEN', envName: 'GITHUB_MODELS_KEY' }],
          },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
      }),
    ).toEqual([{ key: 'GITHUB_MODELS_KEY', value: 'tok' }])
  })

  it('withholds an integration ENTIRELY when another is given a variable it declares', async () => {
    // Two integrations resolving different keys into one variable cannot both be served: the job
    // body is keyed by the injection name and an agent process has one variable per name. Emitting
    // both would hand the agent one vendor's key under the other's name.
    //
    // Dropping only the CLASHING half is the trap this asserts against, and the list made it
    // reachable: `two` would keep `TWO_SECRET`, read `VENDOR_KEY` as its own because that is what
    // its brief says, and sign a request with one vendor's key and another's secret. The 401 that
    // comes back is indistinguishable from a revoked key. Withheld whole, `TWO_SECRET` is unset
    // and the brief's own "do not call this integration" is the honest instruction again.
    const { resolver, subjects } = recordingResolver({
      FIRST_KEY: 'a',
      SECOND_KEY: 'b',
      TWO_SECRET: 'c',
    })
    const logger = createRecordingLogger()
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([
          { ...retro, id: 'one', credentials: [{ key: 'FIRST_KEY', envName: 'VENDOR_KEY' }] },
          {
            ...retro,
            id: 'two',
            credentials: [{ key: 'SECOND_KEY', envName: 'VENDOR_KEY' }, { key: 'TWO_SECRET' }],
          },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
        logger,
      }),
    ).toEqual([{ key: 'VENDOR_KEY', value: 'a' }])
    // …and the withheld integration is never asked for, so a sealed store is not queried for a
    // value nothing can deliver.
    expect(subjects).toEqual([{ kind: 'binary-generator', id: 'one' }])
    const warned = logger.lines.filter((line) => line.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.fields).toMatchObject({
      binaryGeneratorId: 'two',
      credentialEnvName: 'VENDOR_KEY',
      claimedBy: 'one',
    })
  })

  it('refuses a TOOLCHAIN injection name, which would reconfigure the run instead of authenticating', async () => {
    const { resolver, subjects } = recordingResolver({ ACME_IMAGE_TOKEN: 'tok' })
    const logger = createRecordingLogger()
    expect(
      await resolveBinaryGeneratorSecrets({
        context: context([
          { ...retro, credentials: [{ key: 'ACME_IMAGE_TOKEN', envName: 'NODE_OPTIONS' }] },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
        logger,
      }),
    ).toEqual([])
    expect(subjects).toEqual([])
    expect(logger.lines.filter((line) => line.level === 'warn')).toHaveLength(1)
  })
})
