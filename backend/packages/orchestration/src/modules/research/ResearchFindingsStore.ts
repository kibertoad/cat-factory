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
    const home = await this.homeStore(project)
    // Object storage has no batched GET, so each offloaded body is one read of its own.
    return Promise.all(rows.map(async (row) => withBody(row, await readBody(row, home))))
  }

  /**
   * Write a task's revision once and return the body on record. A revision already written
   * under `meta.id` is kept as it is, so a replayed completion stores nothing twice and gets the
   * recorded body back with `written: false`. When two completions race past that check, or the
   * row insert fails, the offloaded copy no row names is deleted again.
   */
  async write(input: {
    runWorkspaceId: string
    project: FindingsProject
    meta: FindingsRevisionMeta
    body: FindingsRevisionBody
  }): Promise<RecordedFindings> {
    const { project, meta } = input
    const existing = await this.deps.findingsRevisionRepository.get(project.id, meta.id)
    if (existing) return { written: false, body: await this.bodyOf(project, existing) }
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
    const written: RecordedFindings = { written: true, body: input.body }
    if (placement.placement === 'inline' || !home.store) {
      const inserted = await this.deps.findingsRevisionRepository.insert({
        ...row,
        body: { kind: 'inline', json },
      })
      return inserted ? written : this.onRecord(project, meta.id)
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
    // The copy is anchored on the project root, which outlives this write, so a copy no row
    // names would be retained for as long as the project: drop it when the insert does not land.
    const store = home.store
    const dropCopy = () =>
      runBestEffort(this.log, 'findings write: drop the unreferenced offloaded copy', () =>
        store.delete(home.workspaceId, artifact.id),
      )
    let inserted: boolean
    try {
      inserted = await this.deps.findingsRevisionRepository.insert({
        ...row,
        body: { kind: 'offloaded', artifactId: artifact.id },
      })
    } catch (error) {
      await dropCopy()
      throw error
    }
    if (inserted) return written
    await dropCopy()
    return this.onRecord(project, meta.id)
  }

  /** The revision another write landed first under `id`. */
  private async onRecord(project: FindingsProject, id: string): Promise<RecordedFindings> {
    const stored = await this.deps.findingsRevisionRepository.get(project.id, id)
    if (!stored) throw new Error(`Findings revision '${id}' was refused but is not on record`)
    return { written: false, body: await this.bodyOf(project, stored) }
  }

  private async bodyOf(
    project: FindingsProject,
    row: FindingsRevisionRow,
  ): Promise<FindingsRevisionBody> {
    if (row.body.kind === 'inline') return decodeBody(row.id, row.body.json)
    return readBody(row, await this.homeStore(project))
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

/** A revision body as {@link ResearchFindingsStore.write} left it on record. */
export interface RecordedFindings {
  /** False when an earlier write already recorded the revision, whose body this is. */
  written: boolean
  body: FindingsRevisionBody
}

/** A row's body, inline or read from the home workspace's blob store. */
async function readBody(
  row: FindingsRevisionRow,
  home: { workspaceId: string; store: BinaryArtifactStore | null },
): Promise<FindingsRevisionBody> {
  if (row.body.kind === 'inline') return decodeBody(row.id, row.body.json)
  const bytes = home.store ? await home.store.getBlob(home.workspaceId, row.body.artifactId) : null
  if (!bytes) throw bodyUnavailable(row.id)
  return decodeBody(row.id, new globalThis.TextDecoder().decode(bytes))
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
