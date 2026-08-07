import { describe, expect, it } from 'vitest'
import type {
  IncidentEnrichmentConnectionRecord,
  IncidentEnrichmentConnectionRepository,
  SecretCipher,
  SecretDelegate,
} from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { WorkspaceIncidentEnrichmentProvider } from './WorkspaceIncidentEnrichmentProvider.js'

// This provider is best-effort by contract: an enrichment failure must never break the on-call
// escalation that triggered it. That makes its one `catch` the exact shape "degrade loudly" warns
// about — a drop here is invisible from every side. Nobody downstream can tell a workspace whose
// credentials could not be opened from one that configured no enrichment at all, and since the
// secrets-delegation slice one of the ways it fails is "the mothership is unreachable", which is
// an outage a laptop's operator has to be told about. So the swallow stays and the silence does
// not; these tests pin the report.

const RECORD = {
  workspaceId: 'ws_1',
  credentials: 'sealed',
} as unknown as IncidentEnrichmentConnectionRecord

function connections(record: IncidentEnrichmentConnectionRecord | null) {
  return {
    async get() {
      return record
    },
  } as unknown as IncidentEnrichmentConnectionRepository
}

/** A cipher that refuses, standing in for the local key on a mothership-sealed row. */
const refusingCipher: SecretCipher = {
  encrypt: async () => 'sealed',
  decrypt: async (): Promise<never> => {
    throw new Error('key mismatch')
  },
}

describe('WorkspaceIncidentEnrichmentProvider', () => {
  it('reports the drop when the credentials cannot be opened, and still does not throw', async () => {
    const log = createRecordingLogger()
    const provider = new WorkspaceIncidentEnrichmentProvider({
      incidentEnrichmentConnectionRepository: connections(RECORD),
      secretCipher: refusingCipher,
      logger: log,
    })

    await expect(
      provider.enrich({ workspaceId: 'ws_1' } as never, {} as never),
    ).resolves.toBeUndefined()

    const warned = log.lines.filter((line) => line.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.fields.workspaceId).toBe('ws_1')
    // The CAUSE, bound through `describeError` so it is scrubbed on the way in.
    expect(warned[0]?.fields.err).toContain('key mismatch')
  })

  it('names the mothership outage rather than reporting the workspace as unconfigured', async () => {
    // The disposition the `SecretDelegate` port forbids a caller from inventing: an unreachable
    // mothership and a workspace with no connection are opposite facts, and only this line tells
    // them apart. A run with no enrichment configured logs nothing at all (below).
    const log = createRecordingLogger()
    const delegate: SecretDelegate = {
      async unseal(): Promise<never> {
        throw new Error('mothership unreachable')
      },
      async seal(): Promise<never> {
        throw new Error('never sealed here')
      },
    }
    const provider = new WorkspaceIncidentEnrichmentProvider({
      incidentEnrichmentConnectionRepository: connections(RECORD),
      secretCipher: refusingCipher,
      secretDelegate: delegate,
      logger: log,
    })

    await provider.enrich({ workspaceId: 'ws_1' } as never, {} as never)

    expect(log.lines.map((line) => line.fields.err)).toEqual([
      expect.stringContaining('mothership unreachable'),
    ])
  })

  it('says nothing about a workspace that configured no enrichment', async () => {
    // The counterpart the two above depend on: if an absent connection also logged, the warn line
    // would stop distinguishing anything and an operator would learn to ignore it.
    const log = createRecordingLogger()
    const provider = new WorkspaceIncidentEnrichmentProvider({
      incidentEnrichmentConnectionRepository: connections(null),
      secretCipher: refusingCipher,
      logger: log,
    })

    await provider.enrich({ workspaceId: 'ws_1' } as never, {} as never)

    expect(log.lines).toEqual([])
  })
})
