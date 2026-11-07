import {
  FINDINGS_INLINE_MAX_BYTES_CEILING,
  type FindingsRevisionBody,
  type FindingsRevisionMeta,
} from '@cat-factory/contracts'
import type {
  BinaryArtifactStore,
  FindingsRevisionRepository,
  FindingsRevisionRow,
} from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { ResearchFindingsStore } from './ResearchFindingsStore.js'

const project = { id: 'prj_1', rootBlockId: 'blk_root' }
const meta: FindingsRevisionMeta = {
  id: 'frv_task_1',
  projectId: project.id,
  taskId: 'task_1',
  seq: 1,
  mode: 'initial',
  definitionKey: 'acme:vendor',
  definitionVersion: 1,
  createdAt: 1,
}

function body(answer: string): FindingsRevisionBody {
  return {
    summary: '',
    learnings: [],
    adhocQuestions: [],
    findings: [
      {
        questionId: 'scheme',
        status: 'answered',
        answer,
        confidence: 'high',
        evidence: [],
        caveats: [],
      },
    ],
  }
}

function revisions(insertResult = true) {
  const rows: FindingsRevisionRow[] = []
  const repo: FindingsRevisionRepository = {
    insert: vi.fn(async (row: FindingsRevisionRow) => {
      if (insertResult) rows.push(row)
      return insertResult
    }),
    get: async (_projectId, id) => rows.find((r) => r.id === id) ?? null,
    listByProject: async () => rows,
  }
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

function findingsStore(opts: {
  repo: FindingsRevisionRepository
  store?: BinaryArtifactStore
  inlineMaxBytes: number
  offload?: 'enabled' | 'disabled'
}) {
  return new ResearchFindingsStore({
    blockRepository: {
      findById: async () => ({ workspaceId: 'ws_home', ownerId: project.id, block: {} as never }),
    },
    workspaceRepository: { accountOf: async () => 'acc_1' },
    findingsRevisionRepository: opts.repo,
    findingsStoragePolicyRepository: {
      get: async (kind) =>
        kind === 'project'
          ? { inlineMaxBytes: opts.inlineMaxBytes, offload: opts.offload ?? 'enabled' }
          : null,
      set: async () => {},
    },
    ...(opts.store ? { resolveBinaryArtifactStore: async () => opts.store! } : {}),
  })
}

describe('ResearchFindingsStore', () => {
  it('offloads a body over the threshold and reads it back from the home workspace', async () => {
    const { repo, rows } = revisions()
    const blobs = blobStore()
    const findings = findingsStore({ repo, store: blobs.store, inlineMaxBytes: 16 })
    await findings.write({ runWorkspaceId: 'ws_run', project, meta, body: body('OAuth 2') })
    expect(rows[0]?.body).toEqual({ kind: 'offloaded', artifactId: 'art_1' })
    expect(blobs.spies.store.mock.calls[0]?.[0]).toMatchObject({
      meta: { workspaceId: 'ws_home', blockId: 'blk_root', kind: 'findings' },
    })
    const [read] = await findings.listRevisions(project)
    expect(read?.body.findings[0]?.answer).toBe('OAuth 2')
  })

  it('writes a replayed completion once', async () => {
    const { repo } = revisions()
    const findings = findingsStore({ repo, inlineMaxBytes: 10_000 })
    await findings.write({ runWorkspaceId: 'ws_run', project, meta, body: body('first') })
    await findings.write({ runWorkspaceId: 'ws_run', project, meta, body: body('replayed') })
    expect(repo.insert).toHaveBeenCalledTimes(1)
  })

  it('deletes its offloaded copy when another writer won the row', async () => {
    const { repo } = revisions(false)
    const blobs = blobStore()
    const findings = findingsStore({ repo, store: blobs.store, inlineMaxBytes: 16 })
    await findings.write({ runWorkspaceId: 'ws_run', project, meta, body: body('lost race') })
    expect(blobs.spies.delete).toHaveBeenCalledWith('ws_home', 'art_1')
  })

  it('deletes its offloaded copy when the row insert fails, and still fails the write', async () => {
    const { repo } = revisions()
    vi.mocked(repo.insert).mockRejectedValueOnce(new Error('db down'))
    const blobs = blobStore()
    const findings = findingsStore({ repo, store: blobs.store, inlineMaxBytes: 16 })
    await expect(
      findings.write({ runWorkspaceId: 'ws_run', project, meta, body: body('no row') }),
    ).rejects.toThrow('db down')
    expect(blobs.spies.delete).toHaveBeenCalledWith('ws_home', 'art_1')
  })

  it('refuses a body over the row ceiling when offload is disabled', async () => {
    const { repo } = revisions()
    const findings = findingsStore({ repo, inlineMaxBytes: 16, offload: 'disabled' })
    const huge = body('x'.repeat(FINDINGS_INLINE_MAX_BYTES_CEILING + 1))
    await expect(
      findings.write({ runWorkspaceId: 'ws_run', project, meta, body: huge }),
    ).rejects.toMatchObject({ details: { reason: 'findings_too_large_for_inline' } })
    expect(repo.insert).not.toHaveBeenCalled()
  })

  it('names an offloaded body it cannot read rather than skipping the revision', async () => {
    const { repo, rows } = revisions()
    rows.push({ ...meta, bodyBytes: 10, body: { kind: 'offloaded', artifactId: 'art_gone' } })
    const findings = findingsStore({ repo, store: blobStore().store, inlineMaxBytes: 16 })
    await expect(findings.listRevisions(project)).rejects.toMatchObject({
      details: { reason: 'findings_body_unavailable' },
    })
  })
})
