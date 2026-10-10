import type { BinaryGeneratorSource, FoundationalBuiltinSource } from '@cat-factory/kernel'
import { AgentKindRegistry } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import {
  buildCapabilityCredentialsView,
  collectDeclaredCapabilityCredentials,
} from './declaredCredentials.js'

// The checklist half of the credential surface. What it must get right is not the join but the
// three states that are NOT "an empty list": a key nothing declares any more, a declaration read
// that FAILED, and a key that resolves from the deployment environment rather than a row.

const registryWithServer = () => {
  const registry = new AgentKindRegistry()
  registry.register({
    kind: 'auditor',
    systemPrompt: 'audit',
    agent: { surface: 'container-explore' },
    toolServers: [
      {
        id: 'issues',
        label: 'Issue tracker',
        transport: { kind: 'stdio', command: 'issue-mcp' },
        secretKeys: [{ key: 'ISSUE_TOKEN' }],
      },
    ],
  })
  // A SECOND kind referencing the same server, which is how the same declaration is seen twice.
  registry.register({
    kind: 'reviewer',
    systemPrompt: 'review',
    agent: { surface: 'container-explore' },
    toolServers: [
      {
        id: 'issues',
        label: 'Issue tracker',
        transport: { kind: 'stdio', command: 'issue-mcp' },
        secretKeys: [{ key: 'ISSUE_TOKEN' }],
      },
    ],
  })
  return registry
}

const generators = (views: unknown[]): BinaryGeneratorSource =>
  ({ views: async () => views, documentsFor: async () => new Map() }) as never

const unreachableGenerators: BinaryGeneratorSource = {
  views: async () => {
    throw new Error('mothership unreachable')
  },
  documentsFor: async () => new Map(),
} as never

const services = (entries: unknown[]): FoundationalBuiltinSource =>
  ({ entries: async () => entries, documentsFor: async () => new Map() }) as never

const noServices = services([])

const unreachableServices: FoundationalBuiltinSource = {
  entries: async () => {
    throw new Error('mothership unreachable')
  },
  documentsFor: async () => new Map(),
} as never

describe('collectDeclaredCapabilityCredentials', () => {
  it('collects both subjects and reports the read as complete', async () => {
    const result = await collectDeclaredCapabilityCredentials({
      foundationalBuiltins: noServices,
      agentKindRegistry: registryWithServer(),
      binaryGenerators: generators([
        { id: 'meshy', name: 'Meshy', credentials: [{ key: 'MESHY_API_KEY', usage: 'Bearer' }] },
      ]),
    })
    expect(result.incomplete).toBe(false)
    expect(result.declared.map((entry) => entry.key).sort()).toEqual([
      'ISSUE_TOKEN',
      'MESHY_API_KEY',
    ])
  })

  it('collects a foundational SERVICE credential as its own subject', async () => {
    // The third declarer. Its absence was the blocker: a step could authenticate to eight vendors
    // and then not to the service it had to store the result in, and the operator had no row to
    // fill in because nothing projected the key.
    const result = await collectDeclaredCapabilityCredentials({
      foundationalBuiltins: services([
        {
          id: 'file-storage',
          name: 'File Storage',
          credentials: [{ key: 'FILE_STORAGE_TOKEN', usage: 'Authorization: Bearer <value>' }],
        },
      ]),
      agentKindRegistry: registryWithServer(),
      binaryGenerators: generators([]),
    })
    expect(result.incomplete).toBe(false)
    expect(result.declared.filter((entry) => entry.subject === 'foundational-service')).toEqual([
      {
        subject: 'foundational-service',
        id: 'file-storage',
        label: 'File Storage',
        key: 'FILE_STORAGE_TOKEN',
        usage: 'Authorization: Bearer <value>',
        required: true,
      },
    ])
  })

  it('reports the list as INCOMPLETE when the catalog read fails, not as empty', async () => {
    // Same rule as the generator half, and the consequence is the same: with the flag unset, every
    // stored key would be reported as orphaned during somebody else's outage, and an operator
    // acting on that list would delete live credentials.
    const result = await collectDeclaredCapabilityCredentials({
      foundationalBuiltins: unreachableServices,
      agentKindRegistry: registryWithServer(),
      binaryGenerators: generators([]),
    })
    expect(result.incomplete).toBe(true)
    expect(result.declared.map((entry) => entry.key)).toEqual(['ISSUE_TOKEN'])
  })

  it('gives a key PAIR a row each, so the form matches the vendor console it is filled from', async () => {
    // A vendor authenticating over HTTP Basic issues two values under two names. One row for them
    // is a checklist that cannot be filled in correctly: whatever the operator types, half of the
    // credential is a convention nobody stated on the surface where they are typing it.
    const result = await collectDeclaredCapabilityCredentials({
      foundationalBuiltins: noServices,
      agentKindRegistry: registryWithServer(),
      binaryGenerators: generators([
        {
          id: 'scenario',
          name: 'Scenario',
          credentials: [
            { key: 'SCENARIO_API_KEY', usage: 'the Basic-auth username half' },
            { key: 'SCENARIO_API_SECRET', usage: 'the Basic-auth password half' },
          ],
        },
      ]),
    })
    expect(
      result.declared
        .filter((entry) => entry.subject === 'binary-generator')
        .map((entry) => [entry.key, entry.usage]),
    ).toEqual([
      ['SCENARIO_API_KEY', 'the Basic-auth username half'],
      ['SCENARIO_API_SECRET', 'the Basic-auth password half'],
    ])
  })

  it('reports ONE declaration for a server two kinds reference', async () => {
    const result = await collectDeclaredCapabilityCredentials({
      foundationalBuiltins: noServices,
      agentKindRegistry: registryWithServer(),
      binaryGenerators: generators([]),
    })
    expect(result.declared).toHaveLength(1)
  })

  it('reaches a server ASSIGNED to a built-in kind, which is no registry entry at all', async () => {
    // The hole this closes: `assignToolServers('coder', …)` is the documented way to give a
    // built-in an MCP server, and the enumeration walked `registry.all()` — so the operator's
    // checklist silently omitted the one key their `coder` runs would need, and the only symptom
    // was the agent reporting the tool unavailable with nothing pointing at the missing value.
    const registry = new AgentKindRegistry()
    registry.registerToolServer({
      id: 'issues',
      label: 'Issue tracker',
      transport: { kind: 'stdio', command: 'issue-mcp' },
      secretKeys: [{ key: 'ISSUE_TOKEN' }],
    })
    registry.assignToolServers('coder', ['issues'])
    const result = await collectDeclaredCapabilityCredentials({
      foundationalBuiltins: noServices,
      agentKindRegistry: registry,
      binaryGenerators: generators([]),
    })
    expect(result.declared).toEqual([
      {
        subject: 'tool-server',
        id: 'issues',
        label: 'Issue tracker',
        key: 'ISSUE_TOKEN',
        required: true,
      },
    ])
  })

  it('still ignores a server registered by id and attached to nothing', async () => {
    // The reason the walk goes through KINDS in the first place: a server no kind can reach never
    // runs, so its credential is a key an operator would fill in for no dispatch.
    const registry = new AgentKindRegistry()
    registry.registerToolServer({
      id: 'orphan',
      transport: { kind: 'stdio', command: 'x' },
      secretKeys: [{ key: 'ORPHAN_TOKEN' }],
    })
    const result = await collectDeclaredCapabilityCredentials({
      foundationalBuiltins: noServices,
      agentKindRegistry: registry,
      binaryGenerators: generators([]),
    })
    expect(result.declared).toEqual([])
  })

  it('marks the read INCOMPLETE when the generator source throws, never an empty list', async () => {
    // `BinaryGeneratorSource` throws rather than answering empty when it cannot reach the
    // mothership. Turning that into "no integration needs a credential" is the exact
    // misattribution the source's own throw exists to prevent.
    const result = await collectDeclaredCapabilityCredentials({
      foundationalBuiltins: noServices,
      agentKindRegistry: registryWithServer(),
      binaryGenerators: unreachableGenerators,
    })
    expect(result.incomplete).toBe(true)
    // The tool-server half is still known and still reported.
    expect(result.declared.map((entry) => entry.key)).toEqual(['ISSUE_TOKEN'])
  })
})

describe('buildCapabilityCredentialsView', () => {
  const declarations = {
    incomplete: false,
    declared: [
      {
        subject: 'tool-server' as const,
        id: 'issues',
        label: 'Issue tracker',
        key: 'ISSUE_TOKEN',
        required: true,
      },
      {
        subject: 'binary-generator' as const,
        id: 'meshy',
        label: 'Meshy',
        key: 'ISSUE_TOKEN',
        required: false,
      },
    ],
  }

  it('groups declarers under one key and takes required if ANY declarer requires it', async () => {
    const view = buildCapabilityCredentialsView({
      declarations,
      stored: [{ key: 'ISSUE_TOKEN', updatedAt: 5 }],
      environmentFallback: true,
    })
    expect(view.declared).toHaveLength(1)
    expect(view.declared[0]?.declaredBy).toHaveLength(2)
    expect(view.declared[0]?.required).toBe(true)
    expect(view.declared[0]?.stored).toBe(true)
    expect(view.declared[0]?.updatedAt).toBe(5)
  })

  it('reports a stored key nothing declares as ORPHANED rather than dropping it', async () => {
    // A live secret nobody will ever ask for, which is what a retired integration leaves behind.
    const view = buildCapabilityCredentialsView({
      declarations,
      stored: [{ key: 'RETIRED_KEY', updatedAt: 1 }],
      environmentFallback: true,
    })
    expect(view.orphaned.map((ref) => ref.key)).toEqual(['RETIRED_KEY'])
    expect(view.declared[0]?.stored).toBe(false)
  })

  it('suppresses the orphan list while the declaration read is INCOMPLETE', async () => {
    // Otherwise an unreachable mothership reports every generator credential as orphaned, and an
    // operator deletes a working one.
    const view = buildCapabilityCredentialsView({
      declarations: { declared: [], incomplete: true },
      stored: [{ key: 'MESHY_API_KEY', updatedAt: 1 }],
      environmentFallback: true,
    })
    expect(view.orphaned).toEqual([])
    expect(view.declarationsIncomplete).toBe(true)
  })

  it('carries the environment-fallback flag, because it decides what a blank row MEANS', async () => {
    const view = buildCapabilityCredentialsView({
      declarations,
      stored: [],
      environmentFallback: false,
    })
    expect(view.environmentFallback).toBe(false)
    expect(view.declared[0]?.stored).toBe(false)
  })

  it('OMITS the flag when the composed chain cannot be described', async () => {
    // A deployment that supplied its own resolver replaced the chain. Reporting either boolean is
    // a claim the platform cannot make, and each sends the operator the wrong way: `true` leaves a
    // credential nothing will resolve, `false` sends them hunting for a value that already answers.
    const view = buildCapabilityCredentialsView({ declarations, stored: [] })
    expect(view.environmentFallback).toBeUndefined()
  })
})
