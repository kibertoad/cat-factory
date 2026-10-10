import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Journal } from './journal.js'
import { acquire, reclaimAll, release, type ResourceRecord } from './resource.js'

// What this module is FOR is a resource that costs money until somebody deletes it, so the three
// properties pinned here are the three ways a pass can lose track of one: provisioning without
// recording, re-provisioning on the way back in, and believing an accepted delete.

type Fields = { ref: string }

// ONE state directory for the file, removed on the way out: `new Journal` per test with a fresh
// `mkdtempSync` left a directory per call under the OS temp dir, and nothing here reads a journal
// back, so what the tests need is a real writer rather than a private one.
const stateDir = mkdtempSync(join(tmpdir(), 'cf-kit-resource-'))
afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

// `say` prints, so an un-silenced run interleaves a dozen of the kit's own milestone lines with the
// reporter's output and a green run stops reading as one.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function journal(): Journal {
  return new Journal(stateDir, 'run-1')
}

const live = (externalId: string): ResourceRecord<Fields> => ({
  externalId,
  fields: { ref: `refs/heads/${externalId}` },
  releasedAt: null,
})

describe('acquire', () => {
  it('records the resource BEFORE anything can observe it', async () => {
    // The whole ordering the module exists for: a process killed between the provision and the
    // record leaves a machine billing against an account with nothing anywhere that can name it.
    const seen: string[] = []
    const result = await acquire<Fields>({
      existing: null,
      journal: journal(),
      label: 'the PR environment',
      provision: async () => {
        seen.push('provisioned')
        return { externalId: 'env-42', fields: { ref: 'refs/heads/main' } }
      },
      onRecord: (record) => seen.push(`recorded ${record.externalId}`),
    })

    expect(seen).toEqual(['provisioned', 'recorded env-42'])
    expect(result.provisioned).toBe(true)
    expect(result.record.releasedAt).toBeNull()
  })

  it('ADOPTS a live record rather than re-provisioning, so the captured fields survive', async () => {
    // Re-requesting would converge where a provider's create is idempotent, and would still lose
    // `fields`: the half no second call answers and the half a teardown needs.
    const provision = vi.fn()
    const result = await acquire<Fields>({
      existing: live('env-42'),
      journal: journal(),
      label: 'the PR environment',
      provision,
      onRecord: () => {},
    })

    expect(provision).not.toHaveBeenCalled()
    expect(result.provisioned).toBe(false)
    expect(result.record.fields).toEqual({ ref: 'refs/heads/env-42' })
  })

  it('provisions again for a record that was RELEASED, which is not the same as a live one', async () => {
    // Adopting a released record hands a scenario an id whose resource no longer answers, which
    // reads as a provider outage rather than as the ledger saying what it actually said.
    const result = await acquire<Fields>({
      existing: { ...live('env-41'), releasedAt: 1 },
      journal: journal(),
      label: 'the PR environment',
      provision: async () => ({ externalId: 'env-42', fields: { ref: 'refs/heads/main' } }),
      onRecord: () => {},
    })

    expect(result.provisioned).toBe(true)
    expect(result.record.externalId).toBe('env-42')
    // PRINTED, not merely filed: this is the one line explaining why a resumed pass did not adopt what
    // its ledger names, and both of its sibling milestones say their piece out loud. Filed silently, an
    // operator watches a second id appear with nothing saying what became of the first.
    const said = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(said.join('\n')).toContain('env-41')
  })
})

describe('release', () => {
  it('records a reclaim only where the PROVIDER agrees, never on an accepted delete', async () => {
    const recorded: ResourceRecord<Fields>[] = []
    const result = await release<Fields>({
      record: live('env-42'),
      journal: journal(),
      label: 'the PR environment',
      teardown: async () => {},
      confirm: async () => false,
      onRecord: (record) => recorded.push(record),
      now: () => 1_000,
    })

    expect(result.status).toBe('unconfirmed')
    expect(recorded).toEqual([])
    // The id, because that is the only handle a provider console search takes.
    expect(result.detail).toContain('env-42')
  })

  it('stamps the record once the provider confirms', async () => {
    const recorded: ResourceRecord<Fields>[] = []
    const result = await release<Fields>({
      record: live('env-42'),
      journal: journal(),
      label: 'the PR environment',
      teardown: async () => {},
      confirm: async () => true,
      onRecord: (record) => recorded.push(record),
      now: () => 1_000,
    })

    expect(result.status).toBe('released')
    expect(recorded).toEqual([{ ...live('env-42'), releasedAt: 1_000 }])
  })

  it('reads a THROWN confirmation as "would not say", never as gone', async () => {
    // The one reading that turns a provider outage into a ledger that has forgotten a running
    // machine. It is also not a failure of the teardown, which was accepted.
    const result = await release<Fields>({
      record: live('env-42'),
      journal: journal(),
      label: 'the PR environment',
      teardown: async () => {},
      confirm: () => Promise.reject(new Error('fetch failed')),
      onRecord: () => {},
    })

    expect(result.status).toBe('unconfirmed')
  })

  it('answers a verdict for a failed teardown rather than throwing at its caller', async () => {
    // Both callers have something more valuable to say than this failure: a scenario asserting on
    // the teardown, and the pass epilogue reporting on everything at once.
    const result = await release<Fields>({
      record: live('env-42'),
      journal: journal(),
      label: 'the PR environment',
      teardown: () => Promise.reject(new Error('403 from the provider')),
      confirm: async () => true,
      onRecord: () => {},
    })

    expect(result.status).toBe('failed')
    expect(result.detail).toContain('403 from the provider')
  })
})

describe('reclaimAll', () => {
  it('says NOTHING when everything came down', async () => {
    // Every line it answers names something an operator has to act on, so a clean reclaim adds
    // nothing to the closing words it is folded into. The counts are in the journal either way.
    const result = await reclaimAll<Fields>({
      records: [live('env-1'), live('env-2')],
      labelOf: (record) => record.externalId,
      journal: journal(),
      teardown: async () => {},
      confirm: async () => true,
      onRecord: () => {},
    })

    expect(result.results).toHaveLength(2)
    expect(result.lines).toEqual([])
  })

  it('names every id still standing, and the remedy, in ONE block', async () => {
    const result = await reclaimAll<Fields>({
      records: [live('env-1'), { ...live('env-2'), releasedAt: 5 }, live('env-3')],
      labelOf: (record) => record.externalId,
      journal: journal(),
      teardown: async (record) => {
        if (record.externalId === 'env-3') throw new Error('403 from the provider')
      },
      confirm: async (record) => record.externalId === 'env-1',
      onRecord: () => {},
      remedy: 'Remove them from the Kargo dashboard.',
    })

    // env-2 was already released, so it is not re-torn-down and not reported.
    expect(result.results.map((entry) => entry.status)).toEqual(['released', 'failed'])
    expect(result.lines[0]).toContain('1 resource(s)')
    expect(result.lines.join('\n')).toContain('env-3')
    expect(result.lines.join('\n')).not.toContain('env-2')
    expect(result.lines.at(-1)).toContain('Kargo dashboard')
  })
})
