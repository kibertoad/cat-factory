import type {
  FindingsRevisionMeta,
  FindingsStorageOwnerKind,
  FindingsStoragePolicy,
  ResearchDefinition,
  ResearchProject,
} from '@cat-factory/contracts'

// Persistence for research: the definitions an account publishes, what each research project
// pins, the findings revisions its tasks write, and the findings-storage policy tiers.

/** A definition an account published through the API. Versions are immutable. */
export interface StoredResearchDefinition {
  accountId: string
  definition: ResearchDefinition
  contentHash: string
  createdAt: number
}

export interface ResearchDefinitionRepository {
  get(accountId: string, key: string, version: number): Promise<StoredResearchDefinition | null>
  /** Every version the account published, keys and versions ascending. */
  listByAccount(accountId: string): Promise<StoredResearchDefinition[]>
  /**
   * Publish a version. Returns false, writing nothing, when that key and version already exist:
   * a published version names one question list forever.
   */
  insert(stored: StoredResearchDefinition): Promise<boolean>
}

export interface ResearchProjectRepository {
  get(projectId: string): Promise<ResearchProject | null>
  insert(project: ResearchProject): Promise<void>
  /**
   * The findings sequence number of a research task, taken the first time the task starts and
   * returned unchanged on every later call, so a replayed or retried start keeps its place and
   * revisions fold in the order their tasks were asked. Two racing first claims for one task can
   * skip a number: a sequence orders revisions, it never counts them.
   */
  reserveTaskSeq(projectId: string, taskId: string): Promise<number>
  /** Reclaim the research rows of deleted projects, revisions included. Empty input is a no-op. */
  deleteMany(projectIds: string[]): Promise<void>
}

/** Where a revision's body lives: inline in its row, or offloaded to the blob store. */
export type FindingsRevisionBodyRef =
  | { kind: 'inline'; json: string }
  | { kind: 'offloaded'; artifactId: string }

export interface FindingsRevisionRow extends FindingsRevisionMeta {
  body: FindingsRevisionBodyRef
  /** The body's size in bytes, whichever way it is stored. */
  bodyBytes: number
}

export interface FindingsRevisionRepository {
  /**
   * Write a revision. First write wins: a replayed write with the same id is ignored and returns
   * false, so it can never recompute against a moved fold.
   */
  insert(row: FindingsRevisionRow): Promise<boolean>
  get(projectId: string, id: string): Promise<FindingsRevisionRow | null>
  /** The project's revisions, `seq` ascending. */
  listByProject(projectId: string): Promise<FindingsRevisionRow[]>
}

export interface FindingsStoragePolicyRepository {
  get(ownerKind: FindingsStorageOwnerKind, ownerId: string): Promise<FindingsStoragePolicy | null>
  /** Set a tier's policy; null clears it, so the tier inherits again. */
  set(
    ownerKind: FindingsStorageOwnerKind,
    ownerId: string,
    policy: FindingsStoragePolicy | null,
  ): Promise<void>
}
