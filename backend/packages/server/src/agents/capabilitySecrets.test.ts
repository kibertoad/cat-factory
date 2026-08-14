import type { AgentRunContext, ToolSecretResolver, ToolSecretSubject } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { resolveCapabilitySecrets } from './capabilitySecrets.js'

// The credentials of a step's registered CAPABILITIES, for one container dispatch: its generative
// binary integrations, and the foundational services it was briefed to read and store through.
// What these pin is the contract the feature rests on: the VALUES leave through the job body
// alone, a key that does not resolve degrades to a stated absence rather than a failed dispatch,
// the resolver is told WHICH KIND of subject it is answering for, and one variable two
// capabilities disagree about is withheld from both however they were registered.

function context(
  generators: AgentRunContext['binaryGenerators'],
  foundationalCredentials?: AgentRunContext['foundationalCredentials'],
): AgentRunContext {
  return {
    agentKind: 'image-generator',
    pipelineName: 'p',
    binaryGenerators: generators,
    foundationalCredentials,
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

describe('resolveCapabilitySecrets', () => {
  const retro = {
    id: 'retro-diffusion',
    label: 'Retro Diffusion',
    modalities: ['image' as const],
    credentials: [{ key: 'RD_TOKEN' }],
  }

  it('resolves each declared credential into a job-body env pair', async () => {
    const { resolver, subjects } = recordingResolver({ RD_TOKEN: 'tok' })
    expect(
      await resolveCapabilitySecrets({
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
      await resolveCapabilitySecrets({
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
    // `required: false` is a state the deployment DECLARED as normal: the endpoint
    // works unauthenticated, and the brief tells the agent to call it anyway. Reporting that at
    // the same severity as a required key that failed to resolve would train an operator to
    // ignore the one that actually costs a step its integration.
    const logger = createRecordingLogger()
    const { resolver } = recordingResolver({})
    expect(
      await resolveCapabilitySecrets({
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
    const secrets = await resolveCapabilitySecrets({
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
      await resolveCapabilitySecrets({
        context: context([retro]),
        workspaceId: 'ws1',
        resolveToolSecrets: broken,
        logger: createRecordingLogger(),
      }),
    ).toEqual([])
  })

  it('asks once per KEY, so two integrations sharing one variable cannot fight over it', async () => {
    const { resolver, subjects } = recordingResolver({ RD_TOKEN: 'tok' })
    const secrets = await resolveCapabilitySecrets({
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
      await resolveCapabilitySecrets({
        context: context([]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
      }),
    ).toEqual([])
    expect(
      await resolveCapabilitySecrets({
        context: context([
          { id: 'open-gen', label: 'Open', modalities: ['image'], credentials: [] },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
      }),
    ).toEqual([])
    expect(subjects).toEqual([])
  })

  it('resolves nothing when the facade wires no secret resolver at all', async () => {
    expect(
      await resolveCapabilitySecrets({ context: context([retro]), workspaceId: 'ws1' }),
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
    const secrets = await resolveCapabilitySecrets({
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
      await resolveCapabilitySecrets({
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
  it('looks the value up under a credential `key` and injects it under its `envName`', async () => {
    const { resolver } = recordingResolver({ ACME_IMAGE_TOKEN: 'tok' })
    expect(
      await resolveCapabilitySecrets({
        context: context([
          { ...retro, credentials: [{ key: 'ACME_IMAGE_TOKEN', envName: 'GITHUB_MODELS_KEY' }] },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
      }),
    ).toEqual([{ key: 'GITHUB_MODELS_KEY', value: 'tok' }])
  })

  it('withholds a variable two integrations want to mean DIFFERENT values, from both of them', async () => {
    // Serving the first claimant sets the variable the SECOND integration's brief tells the agent
    // to read, so it authenticates one vendor with the other's key: a call that fails (or bills
    // the wrong account) with a variable that is present at every layer that could report it.
    // Unset is the one state the brief already describes truthfully, so both are told unavailable.
    const { resolver, subjects } = recordingResolver({ FIRST_KEY: 'a', SECOND_KEY: 'b' })
    const logger = createRecordingLogger()
    expect(
      await resolveCapabilitySecrets({
        context: context([
          { ...retro, id: 'one', credentials: [{ key: 'FIRST_KEY', envName: 'VENDOR_KEY' }] },
          { ...retro, id: 'two', credentials: [{ key: 'SECOND_KEY', envName: 'VENDOR_KEY' }] },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
        logger,
      }),
    ).toEqual([])
    // Nothing is asked for either: the disagreement is settled off the projection, before any I/O.
    expect(subjects).toEqual([])
    const warn = logger.lines.filter((line) => line.level === 'warn')
    expect(warn).toHaveLength(1)
    expect(warn[0]?.fields).toMatchObject({
      credentialEnvName: 'VENDOR_KEY',
      capabilities: ['binary-generator:one', 'binary-generator:two'],
    })
  })

  it('judges a contest on the CASE-FOLDED name, and still injects under the declared spelling', async () => {
    // Two spellings of one variable collide wherever the environment folds case, so the contest is
    // judged there. The dedupe of a SHARED account stays on the exact name, because that spelling
    // is what the brief tells the agent to read: dropping `rd_token` as a duplicate of `RD_TOKEN`
    // would name a variable in the brief that is set nowhere on a platform keeping them apart.
    const { resolver } = recordingResolver({ FIRST_KEY: 'a', SECOND_KEY: 'b', RD_TOKEN: 'c' })
    expect(
      await resolveCapabilitySecrets({
        context: context([
          { ...retro, id: 'one', credentials: [{ key: 'FIRST_KEY', envName: 'VENDOR_KEY' }] },
          { ...retro, id: 'two', credentials: [{ key: 'SECOND_KEY', envName: 'vendor_key' }] },
          { ...retro, id: 'three', credentials: [{ key: 'RD_TOKEN', envName: 'rd_token' }] },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
        logger: createRecordingLogger(),
      }),
    ).toEqual([{ key: 'rd_token', value: 'c' }])
  })

  it('costs a contested integration only the contested variable, never its other credentials', async () => {
    // The withholding is per VARIABLE. An integration that also declares a name nobody else wants
    // still gets that one, so a collision cannot silently widen into an unrelated outage.
    const { resolver } = recordingResolver({ FIRST_KEY: 'a', SECOND_KEY: 'b', SOLO_KEY: 'c' })
    expect(
      await resolveCapabilitySecrets({
        context: context([
          { ...retro, id: 'one', credentials: [{ key: 'FIRST_KEY', envName: 'VENDOR_KEY' }] },
          {
            ...retro,
            id: 'two',
            credentials: [{ key: 'SECOND_KEY', envName: 'VENDOR_KEY' }, { key: 'SOLO_KEY' }],
          },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
        logger: createRecordingLogger(),
      }),
    ).toEqual([{ key: 'SOLO_KEY', value: 'c' }])
  })

  it('resolves EVERY credential one integration declares, so a key pair arrives whole', async () => {
    // A vendor authenticating with HTTP Basic needs both halves in the same process. Resolving
    // only the first would hand the agent a variable that looks set and a call that 401s, which
    // is indistinguishable from a wrong key at every layer that could report it.
    const { resolver, subjects } = recordingResolver({
      SCENARIO_API_KEY: 'kk',
      SCENARIO_API_SECRET: 'ss',
    })
    expect(
      await resolveCapabilitySecrets({
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
      { key: 'SCENARIO_API_KEY', value: 'kk' },
      { key: 'SCENARIO_API_SECRET', value: 'ss' },
    ])
    // ONE call carrying both keys, which is the port's stated contract (once per dispatch per
    // subject) and not just a saving: a per-workspace sealed store re-reads and decrypts the whole
    // workspace bag per call, so asking one name at a time pays that twice for one account.
    expect(subjects).toEqual([{ kind: 'binary-generator', id: 'retro-diffusion' }])
  })

  it('asks for the DISTINCT lookup keys, so one value delivered under two names is asked once', async () => {
    // A definition wanting one stored value under two variables is allowed (only duplicate
    // INJECTION names are refused), and repeating the key in one call would ask the resolver a
    // question it has no way to answer twice.
    const { resolver, subjects } = recordingResolver({ SHARED: 'v' })
    const asked: string[][] = []
    const spy: ToolSecretResolver = {
      resolve: async (req) => {
        asked.push(req.keys.map((k) => k.key))
        return resolver.resolve(req)
      },
    }
    expect(
      await resolveCapabilitySecrets({
        context: context([
          {
            ...retro,
            credentials: [
              { key: 'SHARED', envName: 'VENDOR_A' },
              { key: 'SHARED', envName: 'VENDOR_B' },
            ],
          },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: spy,
      }),
    ).toEqual([
      { key: 'VENDOR_A', value: 'v' },
      { key: 'VENDOR_B', value: 'v' },
    ])
    expect(asked).toEqual([['SHARED']])
    expect(subjects).toHaveLength(1)
  })

  it('judges each credential of one integration by its OWN `required`', async () => {
    // The disposition is per credential, not per integration: an optional second value that did
    // not resolve is a declared-normal state, and reporting it at the severity the required first
    // one earns would train an operator to ignore both.
    const { resolver } = recordingResolver({ SCENARIO_API_KEY: 'kk' })
    const logger = createRecordingLogger()
    expect(
      await resolveCapabilitySecrets({
        context: context([
          {
            ...retro,
            credentials: [{ key: 'SCENARIO_API_KEY' }, { key: 'SCENARIO_ORG_ID', required: false }],
          },
        ]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
        logger,
      }),
    ).toEqual([{ key: 'SCENARIO_API_KEY', value: 'kk' }])
    expect(logger.lines.filter((line) => line.level === 'warn')).toEqual([])
  })

  it('refuses a TOOLCHAIN injection name, which would reconfigure the run instead of authenticating', async () => {
    const { resolver, subjects } = recordingResolver({ ACME_IMAGE_TOKEN: 'tok' })
    const logger = createRecordingLogger()
    expect(
      await resolveCapabilitySecrets({
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

// ---------------------------------------------------------------------------
// The FOUNDATIONAL SERVICE half: what a step authenticates to in order to STORE what it made,
// which the platform had no way to declare until this landed. The rules are the integrations'
// rules, and the cases below are the ones that are only reachable with two producers.
// ---------------------------------------------------------------------------
describe('resolveCapabilitySecrets — foundational services', () => {
  const storage = {
    id: 'file-storage',
    name: 'File Storage',
    credentials: [{ key: 'FILE_STORAGE_TOKEN' }],
  }

  it('resolves a storage service credential under its OWN subject kind', async () => {
    // The subject discriminator is what keeps two registries' ids apart: a deployment may register
    // a `file-storage` tool server beside a `file-storage` catalog service, and a resolver scoping
    // by id alone would hand each the other's secret.
    const { resolver, subjects } = recordingResolver({ FILE_STORAGE_TOKEN: 'tok' })
    expect(
      await resolveCapabilitySecrets({
        context: context([], [storage]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
      }),
    ).toEqual([{ key: 'FILE_STORAGE_TOKEN', value: 'tok' }])
    expect(subjects).toEqual([{ kind: 'foundational-service', id: 'file-storage' }])
  })

  it('serves a generator and a storage service in ONE dispatch', async () => {
    // The shape the whole feature exists for: generate through a vendor, store through the org's
    // own service, both authenticated, neither aware of the other.
    const { resolver } = recordingResolver({ RD_TOKEN: 'a', FILE_STORAGE_TOKEN: 'b' })
    expect(
      await resolveCapabilitySecrets({
        context: context(
          [
            {
              id: 'retro-diffusion',
              label: 'Retro',
              modalities: ['image'],
              credentials: [{ key: 'RD_TOKEN' }],
            },
          ],
          [storage],
        ),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
      }),
    ).toEqual([
      { key: 'RD_TOKEN', value: 'a' },
      { key: 'FILE_STORAGE_TOKEN', value: 'b' },
    ])
  })

  it('withholds a variable a generator and a service disagree about, from BOTH', async () => {
    // The case no registration check can catch: the two are registered on different registries, so
    // only a dispatch ever sees the pair. Serving the generator (which happens to sort first) would
    // set the variable the storage brief tells the agent to read to a vendor API key, and the
    // upload would 401 with a variable present at every layer that could report it.
    const { resolver, subjects } = recordingResolver({ RD_TOKEN: 'a', FILE_STORAGE_TOKEN: 'b' })
    const logger = createRecordingLogger()
    expect(
      await resolveCapabilitySecrets({
        context: context(
          [
            {
              id: 'retro-diffusion',
              label: 'Retro',
              modalities: ['image'],
              credentials: [{ key: 'RD_TOKEN', envName: 'SHARED_TOKEN' }],
            },
          ],
          [{ ...storage, credentials: [{ key: 'FILE_STORAGE_TOKEN', envName: 'SHARED_TOKEN' }] }],
        ),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
        logger,
      }),
    ).toEqual([])
    expect(subjects).toEqual([])
    expect(logger.lines.filter((line) => line.level === 'warn')[0]?.fields).toMatchObject({
      credentialEnvName: 'SHARED_TOKEN',
      capabilities: ['binary-generator:retro-diffusion', 'foundational-service:file-storage'],
    })
  })

  it('refuses a reserved platform key on a service exactly as on an integration', async () => {
    // The floor is re-applied per dispatch rather than trusted from registration, because a
    // mothership-mode node boot-validates none of the definitions it resolves and the environment
    // the key would be read from is a developer's own laptop.
    const { resolver, subjects } = recordingResolver({ ENCRYPTION_KEY: 'master' })
    const logger = createRecordingLogger()
    expect(
      await resolveCapabilitySecrets({
        context: context([], [{ ...storage, credentials: [{ key: 'ENCRYPTION_KEY' }] }]),
        workspaceId: 'ws1',
        resolveToolSecrets: resolver,
        logger,
      }),
    ).toEqual([])
    expect(subjects).toEqual([])
    expect(logger.lines.some((line) => line.level === 'warn')).toBe(true)
  })
})
