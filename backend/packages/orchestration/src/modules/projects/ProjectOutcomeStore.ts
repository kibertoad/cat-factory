import { OUTCOME_INLINE_MAX_BYTES_CEILING, type Project } from '@cat-factory/contracts'
import {
  type BinaryArtifactStore,
  type BlockRepository,
  type Logger,
  type OutcomeStoragePolicyRepository,
  type ProjectOutcomeRow,
  type ProjectRecordRepository,
  type ResolveBinaryArtifactStore,
  UnavailableError,
  ValidationError,
  type WorkspaceRepository,
  noopLogger,
  placeOutcomeBody,
  resolveOutcomeStoragePolicy,
  runBestEffort,
} from '@cat-factory/kernel'
import { readOutcomeStorageTiers } from './OutcomeStoragePolicyService.js'

export interface ProjectOutcomeStoreDeps {
  blockRepository: Pick<BlockRepository, 'findById' | 'findByIds'>
  workspaceRepository: Pick<WorkspaceRepository, 'accountOf'>
  records: ProjectRecordRepository
  policies?: OutcomeStoragePolicyRepository
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  logger?: Logger
}

/** The project fields the store reads: an offloaded body is anchored on the project's root. */
export type OutcomeProject = Pick<Project, 'id' | 'rootBlockId'>

/** A stored outcome with its body's JSON, wherever the body lives. Decoding is the kind's. */
export interface StoredOutcome {
  row: ProjectOutcomeRow
  json: string
}

/** A stored outcome whose body may be unreadable just now (`json: null`). */
export interface ReadOutcome {
  row: ProjectOutcomeRow
  json: string | null
}

/** An outcome body as {@link ProjectOutcomeStore.write} left it on record. */
export interface RecordedOutcome {
  /** False when an earlier write already recorded the outcome, whose body this is. */
  written: boolean
  json: string
}

/**
 * Where a project's outcome bodies live, for every project kind, and the one reader that returns a
 * body wherever it lives. The bodies are opaque JSON here; the kind's module decodes them.
 *
 * A body at or under the effective inline threshold is stored in its outcome row. Above it, the
 * body is offloaded to the account's blob store as an `outcome` artifact anchored on the project's
 * ROOT block in the root's home workspace, so it is reclaimed with the project and carried with it
 * when its home board is deleted and it moves to another. The row then names the artifact, and the
 * reader resolves the home workspace from the root block at read time.
 */
export class ProjectOutcomeStore {
  private readonly log: Logger

  constructor(private readonly deps: ProjectOutcomeStoreDeps) {
    this.log = deps.logger ?? noopLogger
  }

  /** Every outcome of the project with its body's JSON, `seq` ascending. */
  async list(project: OutcomeProject): Promise<StoredOutcome[]> {
    const rows = await this.deps.records.listOutcomes(project.id)
    if (!rows.some((row) => row.body.kind === 'offloaded')) {
      return rows.map((row) => ({ row, json: inlineJson(row) }))
    }
    const home = await this.homeStore(project)
    // Object storage has no batched GET, so each offloaded body is one read of its own.
    return Promise.all(rows.map(async (row) => ({ row, json: await readJson(row, home) })))
  }

  /**
   * Every outcome of several projects with its body's JSON, keyed by project and `seq` ascending,
   * from one outcome read and one root read. Refuses like {@link list} when an offloaded body
   * cannot be read, because a run reads what it links through here.
   */
  async listOfProjects(projects: readonly OutcomeProject[]): Promise<Map<string, StoredOutcome[]>> {
    const rows = await this.deps.records.listOutcomesOfProjects(projects.map((p) => p.id))
    const byProject = new Map<string, ProjectOutcomeRow[]>()
    for (const row of rows)
      byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row])
    const offloading = projects.filter((p) =>
      (byProject.get(p.id) ?? []).some((row) => row.body.kind === 'offloaded'),
    )
    const homes = await this.homeStores(offloading)
    const result = new Map<string, StoredOutcome[]>()
    for (const project of projects) {
      const own = (byProject.get(project.id) ?? []).sort((a, b) => a.seq - b.seq)
      const home = homes.get(project.id)
      result.set(
        project.id,
        await Promise.all(
          own.map(async (row) => ({
            row,
            json: home ? await readJson(row, home) : inlineJson(row),
          })),
        ),
      )
    }
    return result
  }

  /** {@link homeStore} for several projects, their roots resolved in one read. */
  private async homeStores(
    projects: readonly OutcomeProject[],
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
      if (!workspaceId) throw new Error(`project '${project.id}' has no root block`)
      const store = this.deps.resolveBinaryArtifactStore
        ? await this.deps.resolveBinaryArtifactStore(workspaceId)
        : null
      homes.set(project.id, { workspaceId, store })
    }
    return homes
  }

  /**
   * Every outcome with its body's JSON, `seq` ascending, for a reader that states what is missing
   * beside what it can show: an offloaded body that cannot be read now comes back as `json: null`
   * rather than failing the read. A run never reads through this; it reads {@link list}, which
   * refuses.
   */
  async readAll(project: OutcomeProject): Promise<ReadOutcome[]> {
    const rows = await this.deps.records.listOutcomes(project.id)
    const home = rows.some((row) => row.body.kind === 'offloaded')
      ? await this.homeStore(project)
      : null
    return Promise.all(rows.map((row) => this.readTolerantly(row, home)))
  }

  /** One outcome read as {@link readAll} reads it, or null when the project has none by `id`. */
  async readOne(project: OutcomeProject, id: string): Promise<ReadOutcome | null> {
    const row = await this.deps.records.getOutcome(project.id, id)
    if (!row) return null
    const home = row.body.kind === 'offloaded' ? await this.homeStore(project) : null
    return this.readTolerantly(row, home)
  }

  private async readTolerantly(
    row: ProjectOutcomeRow,
    home: { workspaceId: string; store: BinaryArtifactStore | null } | null,
  ): Promise<ReadOutcome> {
    const ref = row.body
    if (ref.kind === 'inline') return { row, json: ref.json }
    const store = home?.store
    if (!home || !store) return { row, json: null }
    const bytes = await runBestEffort(this.log, 'outcome read: offloaded body', () =>
      store.getBlob(home.workspaceId, ref.artifactId),
    )
    return { row, json: bytes ? new globalThis.TextDecoder().decode(bytes) : null }
  }

  /** One outcome of the project with its body's JSON, or null when the project has none by `id`. */
  async get(project: OutcomeProject, id: string): Promise<StoredOutcome | null> {
    const row = await this.deps.records.getOutcome(project.id, id)
    return row ? { row, json: await this.jsonOf(project, row) } : null
  }

  /**
   * Write a task's outcome once and return the body on record. An outcome already written under
   * `row.id` is kept as it is, so a replayed completion stores nothing twice and gets the recorded
   * body back with `written: false`. When two completions race past that check, or the row insert
   * fails, the offloaded copy no row names is deleted again.
   */
  async write(input: {
    runWorkspaceId: string
    project: OutcomeProject
    row: Omit<ProjectOutcomeRow, 'body' | 'bodyBytes'>
    json: string
  }): Promise<RecordedOutcome> {
    const { project, row: meta, json } = input
    const existing = await this.deps.records.getOutcome(project.id, meta.id)
    if (existing) return { written: false, json: await this.jsonOf(project, existing) }
    const bytes = new globalThis.TextEncoder().encode(json)
    const policy = await this.policyFor(input.runWorkspaceId, project.id)
    const place = (blobStoreAvailable: boolean) =>
      placeOutcomeBody({ bytes: bytes.byteLength, policy, blobStoreAvailable })
    const row = { ...meta, bodyBytes: bytes.byteLength }
    const written: RecordedOutcome = { written: true, json }
    const insertInline = async () => {
      const inserted = await this.deps.records.insertOutcome({
        ...row,
        body: { kind: 'inline', json },
      })
      return inserted ? written : this.onRecord(project, meta.id)
    }
    // The blob store is resolved only for a body that leaves the row: resolving it reads the
    // account's storage settings, which an inline body never needs (and a mothership-mode node
    // cannot read).
    if (place(true).placement === 'inline') return insertInline()
    const home = await this.homeStore(project)
    const placement = place(home.store !== null)
    if (placement.placement === 'refused') {
      throw new ValidationError('The outcome is too large to store inline', {
        reason: placement.reason,
        bytes: bytes.byteLength,
      })
    }
    if (placement.placement === 'inline' || !home.store) return insertInline()
    const artifact = await home.store.store({
      meta: {
        workspaceId: home.workspaceId,
        executionId: null,
        blockId: project.rootBlockId,
        kind: 'outcome',
        view: null,
        contentType: 'application/json',
      },
      blob: bytes,
    })
    // The copy is anchored on the project root, which outlives this write, so a copy no row
    // names would be retained for as long as the project: drop it when the insert does not land.
    const store = home.store
    const dropCopy = () =>
      runBestEffort(this.log, 'outcome write: drop the unreferenced offloaded copy', () =>
        store.delete(home.workspaceId, artifact.id),
      )
    let inserted: boolean
    try {
      inserted = await this.deps.records.insertOutcome({
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

  /** The outcome another write landed first under `id`. */
  private async onRecord(project: OutcomeProject, id: string): Promise<RecordedOutcome> {
    const stored = await this.deps.records.getOutcome(project.id, id)
    if (!stored) throw new Error(`Outcome '${id}' was refused but is not on record`)
    return { written: false, json: await this.jsonOf(project, stored) }
  }

  private async jsonOf(project: OutcomeProject, row: ProjectOutcomeRow): Promise<string> {
    if (row.body.kind === 'inline') return row.body.json
    return readJson(row, await this.homeStore(project))
  }

  /** The project root's home workspace and the account's blob store, or null when unset. */
  private async homeStore(
    project: OutcomeProject,
  ): Promise<{ workspaceId: string; store: BinaryArtifactStore | null }> {
    const root = await this.deps.blockRepository.findById(project.rootBlockId)
    if (!root) throw new Error(`project '${project.id}' has no root block`)
    const store = this.deps.resolveBinaryArtifactStore
      ? await this.deps.resolveBinaryArtifactStore(root.workspaceId)
      : null
    return { workspaceId: root.workspaceId, store }
  }

  /** The account, run-workspace and project tiers folded into one policy. */
  private async policyFor(workspaceId: string, projectId: string) {
    const tiers = await readOutcomeStorageTiers(
      {
        ...(this.deps.policies ? { outcomeStoragePolicyRepository: this.deps.policies } : {}),
        workspaceRepository: this.deps.workspaceRepository,
      },
      workspaceId,
      projectId,
    )
    return resolveOutcomeStoragePolicy({
      ...tiers,
      facadeInlineCeilingBytes: OUTCOME_INLINE_MAX_BYTES_CEILING,
    })
  }
}

/** A row's body JSON, inline or read from the home workspace's blob store. */
async function readJson(
  row: ProjectOutcomeRow,
  home: { workspaceId: string; store: BinaryArtifactStore | null },
): Promise<string> {
  if (row.body.kind === 'inline') return row.body.json
  const bytes = home.store ? await home.store.getBlob(home.workspaceId, row.body.artifactId) : null
  if (!bytes) throw bodyUnavailable(row.id)
  return new globalThis.TextDecoder().decode(bytes)
}

function inlineJson(row: ProjectOutcomeRow): string {
  if (row.body.kind !== 'inline') throw bodyUnavailable(row.id)
  return row.body.json
}

/** An offloaded body whose bytes cannot be read: the account's storage is off or the blob is gone. */
function bodyUnavailable(outcomeId: string): UnavailableError {
  return new UnavailableError(
    'A project outcome body is stored in the blob store, which cannot serve it now',
    'outcome_body_unavailable',
    { outcomeId },
  )
}
