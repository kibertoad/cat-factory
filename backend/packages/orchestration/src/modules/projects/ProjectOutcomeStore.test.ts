import { OUTCOME_INLINE_MAX_BYTES_CEILING } from '@cat-factory/contracts'
import type {
  BinaryArtifactStore,
  ProjectOutcomeRow,
  ProjectRecordRepository,
} from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { ProjectOutcomeStore } from './ProjectOutcomeStore.js'

// The store holds bodies as opaque JSON: nothing here is any kind's shape.

const project = { id: 'prj_1', rootBlockId: 'blk_root' }
const meta = {
  id: 'pout_task_1',
  projectId: project.id,
  stream: 'main',
  seq: 1,
  intent: 'initial',
  schemaVersion: 1,
  taskId: 'task_1',
  definitionKey: null,
  definitionVersion: null,
  artifactRefs: [],
  createdAt: 1,
}

const json = (note: string) => JSON.stringify({ note })

function records(insertResult = true) {
  const rows: ProjectOutcomeRow[] = []
  const repo = {
    insertOutcome: vi.fn(async (row: ProjectOutcomeRow) => {
      if (insertResult) rows.push(row)
      return insertResult
    }),
    getOutcome: async (_projectId: string, id: string) => rows.find((r) => r.id === id) ?? null,
    listOutcomes: async () => rows,
  } as unknown as ProjectRecordRepository & { insertOutcome: ReturnType<typeof vi.fn> }
  return { repo, rows }
}

function blobStore() {
  const blobs = new Map<string, Uint8Array>()
  const store = {
    store: vi.fn(async ({ blob }: { blob: Uint8Array }) => {
      blobs.set('art_1', blob)
      return { id: 'art_1' }
    }),
    getBlob: async (_ws: string, id: string) => blobs.get(id) ?? null,
    delete: vi.fn(async (_ws: string, id: string) => {
      blobs.delete(id)
    }),
  }
  return { store: store as unknown as BinaryArtifactStore, blobs, spies: store }
}

function outcomeStore(opts: {
  repo: ProjectRecordRepository
  store?: BinaryArtifactStore
  inlineMaxBytes: number
  offload?: 'enabled' | 'disabled'
}) {
  return new ProjectOutcomeStore({
    blockRepository: {
      findById: async () => ({ workspaceId: 'ws_home', ownerId: project.id, block: {} as never }),
    },
    workspaceRepository: { accountOf: async () => 'acc_1' },
    records: opts.repo,
    policies: {
      get: async (kind) =>
        kind === 'project'
          ? { inlineMaxBytes: opts.inlineMaxBytes, offload: opts.offload ?? 'enabled' }
          : null,
      set: async () => {},
    },
    ...(opts.store ? { resolveBinaryArtifactStore: async () => opts.store! } : {}),
  })
}

describe('ProjectOutcomeStore', () => {
  it('offloads a body over the threshold and reads it back from the home workspace', async () => {
    const { repo, rows } = records()
    const blobs = blobStore()
    const outcomes = outcomeStore({ repo, store: blobs.store, inlineMaxBytes: 8 })
    await outcomes.write({ runWorkspaceId: 'ws_run', project, row: meta, json: json('OAuth 2') })
    expect(rows[0]?.body).toEqual({ kind: 'offloaded', artifactId: 'art_1' })
    expect(blobs.spies.store.mock.calls[0]?.[0]).toMatchObject({
      meta: { workspaceId: 'ws_home', blockId: 'blk_root', kind: 'outcome' },
    })
    const [read] = await outcomes.list(project)
    expect(JSON.parse(read!.json)).toEqual({ note: 'OAuth 2' })
  })

  it('writes a replayed completion once', async () => {
    const { repo } = records()
    const outcomes = outcomeStore({ repo, inlineMaxBytes: 10_000 })
    await outcomes.write({ runWorkspaceId: 'ws_run', project, row: meta, json: json('first') })
    const replay = await outcomes.write({
      runWorkspaceId: 'ws_run',
      project,
      row: meta,
      json: json('replayed'),
    })
    expect(repo.insertOutcome).toHaveBeenCalledTimes(1)
    expect(replay).toEqual({ written: false, json: json('first') })
  })

  it('deletes its offloaded copy when another writer won the row, and returns the winner', async () => {
    const { repo, rows } = records(false)
    const winner = json('won race')
    repo.insertOutcome.mockImplementationOnce(async () => {
      rows.push({ ...meta, bodyBytes: winner.length, body: { kind: 'inline', json: winner } })
      return false
    })
    const blobs = blobStore()
    const outcomes = outcomeStore({ repo, store: blobs.store, inlineMaxBytes: 8 })
    const recorded = await outcomes.write({
      runWorkspaceId: 'ws_run',
      project,
      row: meta,
      json: json('lost race'),
    })
    expect(blobs.spies.delete).toHaveBeenCalledWith('ws_home', 'art_1')
    expect(recorded).toEqual({ written: false, json: winner })
  })

  it('deletes its offloaded copy when the row insert fails, and still fails the write', async () => {
    const { repo } = records()
    repo.insertOutcome.mockRejectedValueOnce(new Error('db down'))
    const blobs = blobStore()
    const outcomes = outcomeStore({ repo, store: blobs.store, inlineMaxBytes: 8 })
    await expect(
      outcomes.write({ runWorkspaceId: 'ws_run', project, row: meta, json: json('no row') }),
    ).rejects.toThrow('db down')
    expect(blobs.spies.delete).toHaveBeenCalledWith('ws_home', 'art_1')
  })

  it('refuses a body over the row ceiling when offload is disabled', async () => {
    const { repo } = records()
    const outcomes = outcomeStore({ repo, inlineMaxBytes: 8, offload: 'disabled' })
    const huge = json('x'.repeat(OUTCOME_INLINE_MAX_BYTES_CEILING + 1))
    await expect(
      outcomes.write({ runWorkspaceId: 'ws_run', project, row: meta, json: huge }),
    ).rejects.toMatchObject({ details: { reason: 'outcome_too_large_for_inline' } })
    expect(repo.insertOutcome).not.toHaveBeenCalled()
  })

  it('names an offloaded body it cannot read rather than skipping the outcome', async () => {
    const { repo, rows } = records()
    rows.push({ ...meta, bodyBytes: 10, body: { kind: 'offloaded', artifactId: 'art_gone' } })
    const outcomes = outcomeStore({ repo, store: blobStore().store, inlineMaxBytes: 8 })
    await expect(outcomes.list(project)).rejects.toMatchObject({
      details: { reason: 'outcome_body_unavailable' },
    })
  })
})
