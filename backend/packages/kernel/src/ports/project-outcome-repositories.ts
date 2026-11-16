import type {
  OutcomeStorageOwnerKind,
  OutcomeStoragePolicy,
  ProjectDefinition,
  ProjectOutcomeMeta,
  ProjectPin,
} from '@cat-factory/contracts'

// Persistence for what projects of any kind keep: the definitions an account publishes, the
// definition a project pins, the outcome revisions its work writes, and the outcome-storage
// policy tiers. Definition specs and outcome bodies are opaque here; the project kind decodes
// them.

/** A definition an account published through the API. Versions are immutable. */
export interface StoredProjectDefinition {
  accountId: string
  definition: ProjectDefinition
  contentHash: string
  createdAt: number
}

export interface ProjectDefinitionRepository {
  get(
    accountId: string,
    kind: string,
    key: string,
    version: number,
  ): Promise<StoredProjectDefinition | null>
  /** Every version of `kind` the account published, keys and versions ascending. */
  listByAccount(accountId: string, kind: string): Promise<StoredProjectDefinition[]>
  /**
   * Publish a version. Returns false, writing nothing, when that kind, key and version already
   * exist: a published version names one definition forever.
   */
  insert(stored: StoredProjectDefinition): Promise<boolean>
}

/** Where an outcome's body lives: inline in its row, or offloaded to the blob store. */
export type ProjectOutcomeBodyRef =
  | { kind: 'inline'; json: string }
  | { kind: 'offloaded'; artifactId: string }

export interface ProjectOutcomeRow extends ProjectOutcomeMeta {
  body: ProjectOutcomeBodyRef
  /** The body's size in bytes, whichever way it is stored. */
  bodyBytes: number
}

/** A project's own records: its pinned definition, its outcome sequence and its outcomes. */
export interface ProjectRecordRepository {
  getPin(projectId: string): Promise<ProjectPin | null>
  /** The pins of the given projects, in no order; a project that pins nothing has none. */
  listPins(projectIds: string[]): Promise<ProjectPin[]>
  insertPin(pin: ProjectPin): Promise<void>
  /**
   * Atomically take the project's next outcome sequence number (1, 2, 3, ...). Taken when the
   * writing work STARTS, so revisions fold in the order the work was asked.
   */
  reserveSeq(projectId: string): Promise<number>
  /**
   * The sequence number of the outcome a task will write, taken the first time the task starts
   * and returned unchanged on every later call, so a replayed or retried start keeps its place.
   * Two racing first claims for one task can skip a number: a sequence orders outcomes, it never
   * counts them.
   */
  reserveTaskSeq(projectId: string, taskId: string): Promise<number>
  /**
   * Write an outcome. First write wins: a replayed write with the same id is ignored and returns
   * false, so it can never recompute against a moved fold.
   */
  insertOutcome(row: ProjectOutcomeRow): Promise<boolean>
  getOutcome(projectId: string, id: string): Promise<ProjectOutcomeRow | null>
  /** The project's outcomes, `seq` ascending; one stream's when `stream` is given. */
  listOutcomes(projectId: string, stream?: string): Promise<ProjectOutcomeRow[]>
  /** The outcomes of several projects in one (chunked) read, each project's `seq` ascending. */
  listOutcomesOfProjects(projectIds: string[]): Promise<ProjectOutcomeRow[]>
  /** Which of the given projects hold at least one outcome, in one (chunked) read. */
  projectsWithOutcomes(projectIds: string[]): Promise<string[]>
  /**
   * Reclaim every record of deleted projects: pins, sequences, outcomes and the project tier of
   * the outcome-storage policy. Empty input is a no-op.
   */
  deleteByProjects(projectIds: string[]): Promise<void>
}

export interface OutcomeStoragePolicyRepository {
  get(ownerKind: OutcomeStorageOwnerKind, ownerId: string): Promise<OutcomeStoragePolicy | null>
  /** Set a tier's policy; null clears it, so the tier inherits again. */
  set(
    ownerKind: OutcomeStorageOwnerKind,
    ownerId: string,
    policy: OutcomeStoragePolicy | null,
  ): Promise<void>
}
