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

export interface ProjectOutcomeStoreDeps {
  blockRepository: Pick<BlockRepository, 'findById'>
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
    const home = await this.homeStore(project)
    const placement = placeOutcomeBody({
      bytes: bytes.byteLength,
      policy: await this.policyFor(input.runWorkspaceId, project.id),
      blobStoreAvailable: home.store !== null,
    })
    if (placement.placement === 'refused') {
      throw new ValidationError('The outcome is too large to store inline', {
        reason: placement.reason,
        bytes: bytes.byteLength,
      })
    }
    const row = { ...meta, bodyBytes: bytes.byteLength }
    const written: RecordedOutcome = { written: true, json }
    if (placement.placement === 'inline' || !home.store) {
      const inserted = await this.deps.records.insertOutcome({
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
    const policies = this.deps.policies
    const accountId = (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? null
    const [account, workspace, project] = policies
      ? await Promise.all([
          accountId ? policies.get('account', accountId) : null,
          policies.get('workspace', workspaceId),
          policies.get('project', projectId),
        ])
      : [null, null, null]
    return resolveOutcomeStoragePolicy({
      account,
      workspace,
      project,
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
