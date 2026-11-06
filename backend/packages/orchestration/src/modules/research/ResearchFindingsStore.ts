import {
  FINDINGS_INLINE_MAX_BYTES_CEILING,
  type FindingsRevision,
  type FindingsRevisionBody,
  type FindingsRevisionMeta,
  type Project,
  parseFindingsRevisionBody,
} from '@cat-factory/contracts'
import {
  type BinaryArtifactStore,
  type BlockRepository,
  type FindingsRevisionRepository,
  type FindingsRevisionRow,
  type FindingsStoragePolicyRepository,
  type Logger,
  type ResolveBinaryArtifactStore,
  UnavailableError,
  ValidationError,
  type WorkspaceRepository,
  noopLogger,
  placeFindingsBody,
  resolveFindingsStoragePolicy,
  runBestEffort,
} from '@cat-factory/kernel'

export interface ResearchFindingsStoreDeps {
  blockRepository: Pick<BlockRepository, 'findById'>
  workspaceRepository: Pick<WorkspaceRepository, 'accountOf'>
  findingsRevisionRepository: FindingsRevisionRepository
  findingsStoragePolicyRepository?: FindingsStoragePolicyRepository
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  logger?: Logger
}

/** The project fields the store reads: an offloaded body is anchored on the project's root. */
export type FindingsProject = Pick<Project, 'id' | 'rootBlockId'>

/**
 * Where a research project's findings revision bodies live, and the one reader that returns a
 * body wherever it lives.
 *
 * A body at or under the effective inline threshold is stored in its revision row. Above it, the
 * body is offloaded to the account's blob store as a `findings` artifact anchored on the project's
 * ROOT block in the root's home workspace, so it is reclaimed with the project and carried with it
 * when its home board is deleted and it moves to another. The row then names the artifact, and the
 * reader resolves the home workspace from the root block at read time.
 */
export class ResearchFindingsStore {
  private readonly log: Logger

  constructor(private readonly deps: ResearchFindingsStoreDeps) {
    this.log = deps.logger ?? noopLogger
  }

  /** Every revision of the project with its body, `seq` ascending. */
  async listRevisions(project: FindingsProject): Promise<FindingsRevision[]> {
    const rows = await this.deps.findingsRevisionRepository.listByProject(project.id)
    if (!rows.some((row) => row.body.kind === 'offloaded')) return rows.map(inlineRevision)
    const { workspaceId, store } = await this.homeStore(project)
    // Object storage has no batched GET, so each offloaded body is one read of its own.
    return Promise.all(
      rows.map(async (row) => {
        if (row.body.kind === 'inline') return inlineRevision(row)
        const bytes = store ? await store.getBlob(workspaceId, row.body.artifactId) : null
        if (!bytes) throw bodyUnavailable(row.id)
        return withBody(row, decodeBody(row.id, new globalThis.TextDecoder().decode(bytes)))
      }),
    )
  }

  /** One revision of the project with its body, or null when the project has no such revision. */
  async getRevision(
    project: FindingsProject,
    revisionId: string,
  ): Promise<FindingsRevision | null> {
    const row = await this.deps.findingsRevisionRepository.get(project.id, revisionId)
    if (!row) return null
    if (row.body.kind === 'inline') return inlineRevision(row)
    const { workspaceId, store } = await this.homeStore(project)
    const bytes = store ? await store.getBlob(workspaceId, row.body.artifactId) : null
    if (!bytes) throw bodyUnavailable(row.id)
    return withBody(row, decodeBody(row.id, new globalThis.TextDecoder().decode(bytes)))
  }

  /**
   * Write a task's revision once. A revision already written under `meta.id` is kept as it is,
   * so a replayed completion stores nothing twice; when two completions race past that check,
   * the loser's offloaded copy is deleted again.
   */
  async write(input: {
    runWorkspaceId: string
    project: FindingsProject
    meta: FindingsRevisionMeta
    body: FindingsRevisionBody
  }): Promise<void> {
    const { project, meta } = input
    if (await this.deps.findingsRevisionRepository.get(project.id, meta.id)) return
    const json = JSON.stringify(input.body)
    const bytes = new globalThis.TextEncoder().encode(json)
    const home = await this.homeStore(project)
    const placement = placeFindingsBody({
      bytes: bytes.byteLength,
      policy: await this.policyFor(input.runWorkspaceId, project.id),
      facadeInlineCeilingBytes: FINDINGS_INLINE_MAX_BYTES_CEILING,
      blobStoreAvailable: home.store !== null,
    })
    if (placement.placement === 'refused') {
      throw new ValidationError('The findings are too large to store inline', {
        reason: placement.reason,
        bytes: bytes.byteLength,
      })
    }
    const row = { ...meta, bodyBytes: bytes.byteLength }
    if (placement.placement === 'inline' || !home.store) {
      await this.deps.findingsRevisionRepository.insert({ ...row, body: { kind: 'inline', json } })
      return
    }
    const artifact = await home.store.store({
      meta: {
        workspaceId: home.workspaceId,
        executionId: null,
        blockId: project.rootBlockId,
        kind: 'findings',
        view: null,
        contentType: 'application/json',
      },
      blob: bytes,
    })
    const written = await this.deps.findingsRevisionRepository.insert({
      ...row,
      body: { kind: 'offloaded', artifactId: artifact.id },
    })
    if (!written) {
      const store = home.store
      await runBestEffort(this.log, 'findings write: drop the losing offloaded copy', () =>
        store.delete(home.workspaceId, artifact.id),
      )
    }
  }

  /** The project root's home workspace and the account's blob store, or null when unset. */
  private async homeStore(
    project: FindingsProject,
  ): Promise<{ workspaceId: string; store: BinaryArtifactStore | null }> {
    const root = await this.deps.blockRepository.findById(project.rootBlockId)
    if (!root) throw new Error(`research project '${project.id}' has no root block`)
    const store = this.deps.resolveBinaryArtifactStore
      ? await this.deps.resolveBinaryArtifactStore(root.workspaceId)
      : null
    return { workspaceId: root.workspaceId, store }
  }

  /** The account, run-workspace and project tiers folded into one policy. */
  private async policyFor(workspaceId: string, projectId: string) {
    const policies = this.deps.findingsStoragePolicyRepository
    const accountId = (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? null
    const [account, workspace, project] = policies
      ? await Promise.all([
          accountId ? policies.get('account', accountId) : null,
          policies.get('workspace', workspaceId),
          policies.get('project', projectId),
        ])
      : [null, null, null]
    return resolveFindingsStoragePolicy({
      account,
      workspace,
      project,
      facadeInlineCeilingBytes: FINDINGS_INLINE_MAX_BYTES_CEILING,
    })
  }
}

function inlineRevision(row: FindingsRevisionRow): FindingsRevision {
  if (row.body.kind !== 'inline') throw bodyUnavailable(row.id)
  return withBody(row, decodeBody(row.id, row.body.json))
}

function withBody(row: FindingsRevisionRow, body: FindingsRevisionBody): FindingsRevision {
  const { body: _ref, bodyBytes: _bytes, ...meta } = row
  return { ...meta, body }
}

function decodeBody(revisionId: string, json: string): FindingsRevisionBody {
  const body = parseFindingsRevisionBody(JSON.parse(json))
  if (!body) throw new Error(`Findings revision '${revisionId}' holds an unreadable body`)
  return body
}

/** An offloaded body whose bytes cannot be read: the account's storage is off or the blob is gone. */
function bodyUnavailable(revisionId: string): UnavailableError {
  return new UnavailableError(
    'A findings revision body is stored in the blob store, which cannot serve it now',
    'findings_body_unavailable',
    { revisionId },
  )
}
