import { defaultAgentKindRegistry } from '@cat-factory/agents'
import {
  defaultBinaryGeneratorRegistry,
  defaultFoundationalServiceRegistry,
  defaultGateRegistry,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { collectRegistrationProblems } from './validateRegistrations.js'

// Section 11: two registered capabilities claiming one environment variable for different lookup
// keys. It is the ONE place that fault is graded, and both halves of "one place" are load-bearing.
//
// Scoped per registry it was WRONG IN BOTH DIRECTIONS. A generator-vs-generator pair was graded by
// the generator section AND by this one, so one variable produced two problems with two codes and
// two remediations. A service-vs-service pair was graded by neither. The assertions below are
// therefore about the COUNT and the CODES of what boot reports, not just that something failed:
// filtering to one code is what let the double report ship green.

const gates = defaultGateRegistry()
const kinds = defaultAgentKindRegistry()

type GeneratorInput = Parameters<ReturnType<typeof defaultBinaryGeneratorRegistry>['register']>[0]
type ServiceInput = Parameters<ReturnType<typeof defaultFoundationalServiceRegistry>['register']>[0]

const generator = {
  id: 'retro-diffusion',
  name: 'Retro Diffusion',
  summary: 'Pixel-art image generation.',
  description: 'Sprites and tiles; not photorealism.',
  modalities: ['image' as const],
  mediaTypes: ['image/png'],
  endpoint: 'https://api.retrodiffusion.ai/v1',
}

const service = {
  id: 'file-storage',
  name: 'File Storage',
  summary: 'Stores uploads.',
  description: '',
  capabilities: ['asset-storage'],
  contracts: [
    {
      contractId: 'http',
      format: 'openapi' as const,
      title: 'HTTP API',
      body: 'openapi: 3.0.3\npaths:\n  /files:\n    get: {}\n',
    },
  ],
}

/** Boot's problems for a given pair of registries, unfiltered: the count IS the assertion here. */
function problemsFor(input: { generators?: GeneratorInput[]; services?: ServiceInput[] }) {
  const binaryGeneratorRegistry = defaultBinaryGeneratorRegistry()
  binaryGeneratorRegistry.registerAll(input.generators ?? [])
  const foundationalServiceRegistry = defaultFoundationalServiceRegistry()
  foundationalServiceRegistry.registerAll(input.services ?? [])
  return collectRegistrationProblems({
    registries: {
      agentKindRegistry: kinds,
      gateRegistry: gates,
      binaryGeneratorRegistry,
      foundationalServiceRegistry,
    },
  })
}

describe('credential injection-name collisions', () => {
  it('reports two INTEGRATIONS colliding exactly once', () => {
    // The regression this file exists for. Both registries are wired on every real facade, so the
    // pair below met two rules and produced two problems naming one variable.
    const problems = problemsFor({
      generators: [
        {
          ...generator,
          id: 'retro-diffusion',
          credentials: [{ key: 'RD', envName: 'VENDOR_KEY' }],
        },
        { ...generator, id: 'studio-music', credentials: [{ key: 'SK', envName: 'VENDOR_KEY' }] },
      ],
    })
    expect(problems.map((problem) => problem.code)).toEqual(['capability_injection_name_collision'])
    expect(problems[0]?.message).toContain('VENDOR_KEY')
    expect(problems[0]?.message).toContain('retro-diffusion')
    expect(problems[0]?.message).toContain('studio-music')
  })

  it('reports two SERVICES colliding, which no per-registry rule graded at all', () => {
    const problems = problemsFor({
      services: [
        { ...service, id: 'file-storage', credentials: [{ key: 'FS', envName: 'STORE_KEY' }] },
        { ...service, id: 'asset-index', credentials: [{ key: 'AI', envName: 'STORE_KEY' }] },
      ],
    })
    expect(problems.map((problem) => problem.code)).toEqual(['capability_injection_name_collision'])
    expect(problems[0]?.message).toContain('service "file-storage"')
    expect(problems[0]?.message).toContain('service "asset-index"')
  })

  it('reports a pair that spans the two registries, naming which registry each is in', () => {
    // The case that only meets when a step selects both, so an id alone would leave an operator
    // hunting for which registry to edit.
    const problems = problemsFor({
      generators: [{ ...generator, credentials: [{ key: 'RD', envName: 'SHARED_KEY' }] }],
      services: [{ ...service, credentials: [{ key: 'FS', envName: 'SHARED_KEY' }] }],
    })
    expect(problems.map((problem) => problem.code)).toEqual(['capability_injection_name_collision'])
    expect(problems[0]?.message).toContain('integration "retro-diffusion"')
    expect(problems[0]?.message).toContain('service "file-storage"')
  })

  it('still grades a collision when only ONE registry is wired', () => {
    // The rule used to bail unless BOTH registries were supplied, which is how the
    // generator-only deployment lost the check when its own section stopped grading it.
    const binaryGeneratorRegistry = defaultBinaryGeneratorRegistry()
    binaryGeneratorRegistry.registerAll([
      { ...generator, id: 'retro-diffusion', credentials: [{ key: 'RD', envName: 'VENDOR_KEY' }] },
      { ...generator, id: 'studio-music', credentials: [{ key: 'SK', envName: 'VENDOR_KEY' }] },
    ])
    const problems = collectRegistrationProblems({
      registries: { agentKindRegistry: kinds, gateRegistry: gates, binaryGeneratorRegistry },
    })
    expect(problems.map((problem) => problem.code)).toEqual(['capability_injection_name_collision'])
  })

  it('compares case-folded, so a pair collides on the platform nobody would see it on', () => {
    // `process.env` lookup ignores case on Windows: `VENDOR_KEY` and `vendor_key` are two
    // declarations and one variable there, and an exact comparison would pass the collision.
    const problems = problemsFor({
      generators: [{ ...generator, credentials: [{ key: 'RD', envName: 'VENDOR_KEY' }] }],
      services: [{ ...service, credentials: [{ key: 'FS', envName: 'vendor_key' }] }],
    })
    expect(problems.map((problem) => problem.code)).toEqual(['capability_injection_name_collision'])
  })

  it('accepts capabilities SHARING one account: one name over one lookup key', () => {
    // An org running its own storage and its own generation endpoint off one token is the working
    // case, not a collision: whichever resolves first sets the variable to exactly what the other
    // wanted. A rule keyed on the NAME alone would refuse it.
    expect(
      problemsFor({
        generators: [{ ...generator, credentials: [{ key: 'ORG_TOKEN' }] }],
        services: [{ ...service, credentials: [{ key: 'ORG_TOKEN' }] }],
      }),
    ).toEqual([])
  })

  it('grades only definitions that PARSED, so one fault is never restated as two', () => {
    // Both definitions are refused by their own sections (a reserved platform variable as a lookup
    // key), and reading their credentials here would add a collision report about a declaration
    // that was already rejected.
    const problems = problemsFor({
      generators: [{ ...generator, credentials: [{ key: 'ENCRYPTION_KEY' }] }],
      services: [{ ...service, credentials: [{ key: 'ENCRYPTION_KEY' }] }],
    })
    expect(problems.map((problem) => problem.code).sort()).toEqual([
      'binary_generator_invalid',
      'foundational_service_invalid',
    ])
  })
})
