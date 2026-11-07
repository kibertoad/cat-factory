import {
  FINDINGS_INLINE_MAX_BYTES_CEILING,
  type FindingsRevision,
  type FindingsRevisionBody,
  type FindingsRevisionMeta,
  type FindingsRevisionStorage,
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
import { readFindingsStorageTiers } from './FindingsStoragePolicyService.js'

export interface ResearchFindingsStoreDeps {
  blockRepository: Pick<BlockRepository, 'findById' | 'findByIds'>
  workspaceRepository: Pick<WorkspaceRepository, 'accountOf'>
  findingsRevisionRepository: FindingsRevisionRepository
  findingsStoragePolicyRepository?: FindingsStoragePolicyRepository
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  logger?: Logger
}

/** A revision as {@link ResearchFindingsStore.readRevisions} returns it. */
export interface ReadRevision {
  meta: FindingsRevisionMeta
  storage: FindingsRevisionStorage
  body: FindingsRevisionBody | null
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

  /**
   * Every revision with where its body lives, `seq` ascending. An offloaded body that cannot be
   * read comes back as `body: null` with `readable: false` rather than failing the read, so a
   * reader states what is missing beside what it can show.
   */
  async readRevisions(project: FindingsProject): Promise<ReadRevision[]> {
    const rows = await this.deps.findingsRevisionRepository.listByProject(project.id)
    const home = rows.some((row) => row.body.kind === 'offloaded')
      ? await this.homeStore(project)
      : null
    return Promise.all(rows.map((row) => this.readRow(row, home)))
  }

  /** One revision with where its body lives, or null when the project has no such revision. */
  async readRevision(project: FindingsProject, revisionId: string): Promise<ReadRevision | null> {
    const row = await this.deps.findingsRevisionRepository.get(project.id, revisionId)
    if (!row) return null
    const home = row.body.kind === 'offloaded' ? await this.homeStore(project) : null
    return this.readRow(row, home)
  }

  private async readRow(
    row: FindingsRevisionRow,
    home: { workspaceId: string; store: BinaryArtifactStore | null } | null,
  ): Promise<ReadRevision> {
    const { body: ref, bodyBytes, ...meta } = row
    const placement = ref.kind === 'inline' ? ('inline' as const) : ('offloaded' as const)
    let body: FindingsRevisionBody | null = null
    if (ref.kind === 'inline') {
      body = parseStoredBody(ref.json)
    } else if (home?.store) {
      const store = home.store
      const bytes = await runBestEffort(this.log, 'findings read: offloaded body', () =>
        store.getBlob(home.workspaceId, ref.artifactId),
      )
      body = bytes ? parseStoredBody(new globalThis.TextDecoder().decode(bytes)) : null
    }
    return { meta, storage: { placement, bytes: bodyBytes, readable: body !== null }, body }
  }

  /** Every revision of the project with its body, `seq` ascending. */
  async listRevisions(project: FindingsProject): Promise<FindingsRevision[]> {
    const rows = await this.deps.findingsRevisionRepository.listByProject(project.id)
    if (!rows.some((row) => row.body.kind === 'offloaded')) return rows.map(inlineRevision)
    return this.withBodies(rows, await this.homeStore(project))
  }

  /**
   * Every revision of several projects with its body, keyed by project and `seq` ascending, from
   * one revision read. Throws `findings_body_unavailable` when an offloaded body cannot be read.
   */
  async listRevisionsOfProjects(
    projects: readonly FindingsProject[],
  ): Promise<Map<string, FindingsRevision[]>> {
    const rows = await this.deps.findingsRevisionRepository.listByProjects(
      projects.map((p) => p.id),
    )
    const byProject = new Map<string, FindingsRevisionRow[]>()
    for (const row of rows)
      byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row])
    const offloading = projects.filter((p) =>
      (byProject.get(p.id) ?? []).some((row) => row.body.kind === 'offloaded'),
    )
    const homes = await this.homeStores(offloading)
    const result = new Map<string, FindingsRevision[]>()
    for (const project of projects) {
      const own = (byProject.get(project.id) ?? []).sort((a, b) => a.seq - b.seq)
      const home = homes.get(project.id)
      result.set(project.id, home ? await this.withBodies(own, home) : own.map(inlineRevision))
    }
    return result
  }

  /** {@link homeStore} for several projects, their roots resolved in one read. */
  private async homeStores(
    projects: readonly FindingsProject[],
  ): Promise<Map<string, { workspaceId: string; store: BinaryArtifactStore | null }>> {
    const homes = new Map<string, { workspaceId: string; store: BinaryArtifactStore | null }>()
    if (projects.length === 0) return homes
    const roots = new Map(
      (await this.deps.blockRepository.findByIds(projects.map((p) => p.rootBlockId))).map(
        (found) => [found.block.id, found.workspaceId] as const,
      ),
    )
    for (const project of projects) {
      const workspaceId = roots.get(project.rootBlockId)
      if (!workspaceId) throw new Error(`research project '${project.id}' has no root block`)
      const store = this.deps.resolveBinaryArtifactStore
        ? await this.deps.resolveBinaryArtifactStore(workspaceId)
        : null
      homes.set(project.id, { workspaceId, store })
    }
    return homes
  }

  /** Read every offloaded body of `rows` from the project's home store; object storage has no batched GET. */
  private withBodies(
    rows: readonly FindingsRevisionRow[],
    home: { workspaceId: string; store: BinaryArtifactStore | null },
  ): Promise<FindingsRevision[]> {
    return Promise.all(
      rows.map(async (row) => {
        if (row.body.kind === 'inline') return inlineRevision(row)
        const bytes = home.store
          ? await home.store.getBlob(home.workspaceId, row.body.artifactId)
          : null
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
    return resolveFindingsStoragePolicy({
      ...(await readFindingsStorageTiers(this.deps, workspaceId, projectId)),
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

/** A stored body that does not parse is reported as unreadable, never as an empty revision. */
function parseStoredBody(json: string): FindingsRevisionBody | null {
  try {
    return parseFindingsRevisionBody(JSON.parse(json)) ?? null
  } catch {
    return null
  }
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
