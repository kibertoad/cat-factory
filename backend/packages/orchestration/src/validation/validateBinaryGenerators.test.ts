import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { defaultBinaryGeneratorRegistry, defaultGateRegistry } from '@cat-factory/kernel'
import { collectRegistrationProblems } from './validateRegistrations.js'

// Section 9 of `collectRegistrationProblems`, tested beside the module it lives in
// (`validateBinaryGenerators.ts`) rather than in `extension-registries.test.ts`, where it grew up
// with the rest of the registry validation and where it had become the largest single section.

describe('generative binary integration registry validation', () => {
  const gates = defaultGateRegistry()
  const kinds = defaultAgentKindRegistry()
  const problemsFor = (
    definitions: Parameters<ReturnType<typeof defaultBinaryGeneratorRegistry>['register']>[0][],
  ) => {
    const binaryGeneratorRegistry = defaultBinaryGeneratorRegistry()
    binaryGeneratorRegistry.registerAll(definitions)
    return collectRegistrationProblems({
      registries: {
        agentKindRegistry: kinds,
        gateRegistry: gates,
        binaryGeneratorRegistry,
      },
    }).filter((p) => p.code.startsWith('binary_generator') || p.code.endsWith('generator_endpoint'))
  }

  const valid = {
    id: 'retro-diffusion',
    name: 'Retro Diffusion',
    summary: 'Pixel-art image generation.',
    description: 'Sprites and tiles; not photorealism.',
    modalities: ['image' as const],
    mediaTypes: ['image/png'],
    endpoint: 'https://api.retrodiffusion.ai/v1',
    credentials: [{ key: 'RD_TOKEN', usage: 'the X-RD-Token header' }],
  }

  it('passes a well-formed registration', () => {
    expect(problemsFor([valid])).toEqual([])
  })

  it('fails boot on a credential key that is not a usable environment variable name', () => {
    // The failure it replaces: the harness drops the malformed name at parse and the integration
    // 401s mid-run, naming nothing that points back at the registration.
    const problems = problemsFor([{ ...valid, credentials: [{ key: 'x-rd-token' }] }])
    expect(problems[0]?.message).toContain('environment variable name')
  })

  it('fails boot on a credential naming a PLATFORM configuration variable', () => {
    // A definition names both the key it wants and the endpoint that key is sent to, so this is a
    // registration that booted clean and shipped the deployment's master sealing key to a third
    // party. Enforced by the credential SCHEMA, so it reaches boot through the same parse.
    const problems = problemsFor([{ ...valid, credentials: [{ key: 'ENCRYPTION_KEY' }] }])
    expect(problems[0]?.code).toBe('binary_generator_invalid')
    expect(problems[0]?.message).toContain('the platform')
    // Case-insensitively, because `process.env` lookup is on Windows.
    expect(problemsFor([{ ...valid, credentials: [{ key: 'encryption_key' }] }])).toHaveLength(1)
  })

  it('accepts the KEY PAIR a Basic-auth vendor needs, as two declared credentials', () => {
    // The shape this field became a list for: an API key and an API secret are two values the
    // vendor's own console issues separately, and colon-joining them into one variable rotates
    // them together and turns a mis-joined value into a 401 that reads as a wrong key.
    expect(
      problemsFor([
        {
          ...valid,
          credentials: [
            { key: 'SCENARIO_API_KEY', usage: 'the Basic-auth username half' },
            { key: 'SCENARIO_API_SECRET', usage: 'the Basic-auth password half' },
          ],
        },
      ]),
    ).toEqual([])
  })

  it('fails boot when two credentials would arrive as ONE environment variable', () => {
    // The job body is keyed by the injection name, so a collision does not conflict loudly: one
    // value silently wins and the integration authenticates with half a pair. Refused where the
    // declaration is, since neither the resolver nor the agent can tell afterwards which half it
    // got. The LOOKUP keys differ here, which is what makes the collision easy to write by hand.
    const problems = problemsFor([
      {
        ...valid,
        credentials: [
          { key: 'SCENARIO_API_KEY', envName: 'SCENARIO_AUTH' },
          { key: 'SCENARIO_API_SECRET', envName: 'SCENARIO_AUTH' },
        ],
      },
    ])
    expect(problems[0]?.code).toBe('binary_generator_invalid')
    expect(problems[0]?.message).toContain('its own environment variable')
    // The same collision through the FALLBACK: an entry with no `envName` arrives as its lookup
    // key, so this pair collides too and a check reading `envName` alone would pass it.
    expect(
      problemsFor([
        {
          ...valid,
          credentials: [
            { key: 'SCENARIO_AUTH' },
            { key: 'SCENARIO_API_SECRET', envName: 'SCENARIO_AUTH' },
          ],
        },
      ]),
    ).toHaveLength(1)
  })

  // A collision ACROSS definitions is graded by section 11 rather than here, over every capability
  // registry at once, so its cases live in `validateCredentialInjection.test.ts`. This section keeps
  // only what is true of ONE definition: two of ITS OWN credentials arriving as one variable, which
  // the schema refuses at the parse above.

  it('fails boot on a cleartext endpoint off loopback, because the credential rides it', () => {
    const problems = problemsFor([{ ...valid, endpoint: 'http://api.example.com/v1' }])
    expect(problems[0]?.code).toBe('insecure_binary_generator_endpoint')
    expect(problemsFor([{ ...valid, endpoint: 'http://localhost:8080' }])).toEqual([])
  })

  it('fails boot when a declared media type contradicts the declared content types', () => {
    // Both halves drive selection — coverage is checked against `modalities`, while the brief
    // tells the agent the `mediaTypes` — so this integration would be picked for one job and
    // asked to do the other.
    const problems = problemsFor([{ ...valid, modalities: ['audio'], mediaTypes: ['image/png'] }])
    expect(problems[0]?.code).toBe('binary_generator_modality_mismatch')
  })

  it('accepts a media type it cannot classify rather than refusing a format it has not heard of', () => {
    expect(problemsFor([{ ...valid, mediaTypes: ['application/x-newfangled'] }])).toEqual([])
  })

  it('accepts EITHER 3D content type against a container that could hold both', () => {
    // Contradiction is an empty INTERSECTION, not an absent member. A `.glb` is one asset or a
    // whole scene and the container does not record which, so requiring every consistent member
    // would refuse a scene generator for declaring the only format it can emit.
    for (const modalities of [['3d-model'], ['3d-scene'], ['3d-model', '3d-scene']] as const) {
      expect(
        problemsFor([{ ...valid, modalities: [...modalities], mediaTypes: ['model/gltf-binary'] }]),
      ).toEqual([])
    }
    // …and a genuine contradiction is still one.
    expect(
      problemsFor([{ ...valid, modalities: ['audio'], mediaTypes: ['model/gltf-binary'] }])[0]
        ?.code,
    ).toBe('binary_generator_modality_mismatch')
  })

  // The same class of contradiction one axis finer, and the harder one to spot by reading the
  // definition: every reader believes a different half. The brief states the set as fact, the
  // value rule never sees it (it judges over the capability's declarers), and admission refuses
  // every step that asks for the option at all.
  it('fails boot when a stated value set has no capability to be asked through', () => {
    const problems = problemsFor([
      { ...valid, capabilities: ['seed'], accepts: { aspectRatios: ['1:1'] } },
    ])
    expect(problems[0]?.code).toBe('binary_generator_accepts_without_capability')
    expect(problems[0]?.message).toContain('aspect-ratio')
    expect(
      problemsFor([
        { ...valid, capabilities: ['aspect-ratio'], accepts: { aspectRatios: ['1:1'] } },
      ]),
    ).toEqual([])
  })

  it('reports a malformed definition ONCE rather than restating it as several', () => {
    expect(
      problemsFor([{ ...valid, id: 'Retro Diffusion', endpoint: 'http://api.example.com' }]),
    ).toHaveLength(1)
  })

  it('requires at least one content type — a generator that produces nothing is not one', () => {
    expect(problemsFor([{ ...valid, modalities: [] }])).toHaveLength(1)
  })

  // The HARNESS transport's one rule that needs more than the definition itself: the schema can
  // check that a harness is NAMED, but only this layer can see kernel's closed `HarnessKind` list.
  describe('harness transport', () => {
    const harnessServed = {
      id: 'codex-images',
      name: 'Codex image generation',
      summary: 'gpt-image-2 through the Codex CLI.',
      description: 'Served by the agent CLI itself; no API and no key.',
      modalities: ['image' as const],
      mediaTypes: ['image/png'],
      transport: 'harness' as const,
      harness: 'codex',
    }

    it('accepts an integration served by a harness this build runs', () => {
      expect(problemsFor([harnessServed])).toEqual([])
    })

    it('refuses a harness this build does not run', () => {
      // A typo pins the step to a CLI no dispatch resolves, so every run selecting it is refused
      // at admission with a message naming a harness that does not exist. The remedy is one string
      // in the deployment's own code, which is what boot validation is for.
      const problems = problemsFor([{ ...harnessServed, harness: 'codecs' }])
      expect(problems).toHaveLength(1)
      expect(problems[0]?.code).toBe('binary_generator_unknown_harness')
      expect(problems[0]?.message).toContain('codecs')
      expect(problems[0]?.message).toContain('codex')
    })

    it('refuses a harness this build DOES run but which cannot generate', () => {
      // The failure that reads as a working registration: `claude-code` passes every structural
      // check, admission resolves a claude-code step and admits it, the dispatch sets the flag,
      // the runner ignores it, and the brief tells the agent to collect from a staging directory
      // nothing created. The run then reports a model problem for one string of deployment code.
      const problems = problemsFor([{ ...harnessServed, harness: 'claude-code' }])
      expect(problems).toHaveLength(1)
      expect(problems[0]?.code).toBe('binary_generator_unknown_harness')
      expect(problems[0]?.message).toContain('no built-in generation tool')
      // And it names what CAN serve one, since that is the whole remedy.
      expect(problems[0]?.message).toContain('codex')
    })

    it('never raises it for an ordinary api integration', () => {
      expect(problemsFor([valid])).toEqual([])
    })
  })
})
