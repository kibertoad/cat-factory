import type {
  AddServiceFromRepoInput,
  Block,
  BlockEditAuthority,
  GitHubRepo,
  SourceTask,
  TaskSourceKind,
  UpdateBlockInput,
} from '@cat-factory/contracts'
import type { Service } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// What the built-in assistant actions need from the platform, as bound call-backs.
//
// Call-backs rather than the services themselves, for the reason every collaborator in this
// package takes them: an action performs the SAME operation the board's own button does, through
// the same method, and naming the method it calls is the whole dependency. Holding `BoardService`
// would additionally hold everything else on it, and the composition root is where the two halves
// (board writes here, tracker reads in the tasks module) are joined anyway, and an action
// reaching across that seam itself is what the seam exists to prevent.
//
// Each group is optional at the WIRING level, not here: an action whose dependencies a deployment
// did not configure is not registered at all, so a turn that routes to it declines rather than
// promising something the deployment cannot do.
// ---------------------------------------------------------------------------

/** Board reads + writes every action shares. */
export interface AssistantBoardDeps {
  /**
   * The board's blocks AS THE PERSON SEES THEM, mounted shared services included.
   *
   * Deliberately the composed board rather than the workspace's own rows: a service another team
   * homes and this board mounts is on screen, is nameable in a sentence, and is a legitimate end
   * of a dependency edge. Resolving names against the narrower read would answer "there is no
   * such service" about a frame the person is looking at.
   */
  listBoardBlocks(workspaceId: string): Promise<Block[]>
  /** Apply a patch to a block, under the asker's own tier. */
  updateBlock(
    workspaceId: string,
    id: string,
    patch: UpdateBlockInput,
    editor: BlockEditAuthority,
  ): Promise<Block>
}

/** What the repository-backed service action needs. Absent ⇒ no VCS integration is wired. */
export interface AssistantRepoDeps {
  /** The repositories this workspace projects, for resolving a pasted URL to one. */
  listRepos(workspaceId: string): Promise<GitHubRepo[]>
  /** Create (or mount) the service frame backed by a projected repository. */
  addServiceFromRepo(workspaceId: string, input: AddServiceFromRepoInput): Promise<Block>
  /** The account-owned services behind a set of frames, for the repo → frame linkage. */
  listServicesForFrames(frameBlockIds: string[]): Promise<Service[]>
}

/** One connected tracker that recognises a pasted issue URL. */
export interface AssistantIssueMatch {
  source: TaskSourceKind
  /** The source's canonical key for the issue, as its own provider parsed it. */
  externalId: string
}

/** What the tracker-issue action needs. Absent ⇒ no task source is wired. */
export interface AssistantIssueDeps {
  /**
   * Every ENABLED task source whose provider recognises this reference.
   *
   * Plural on purpose: which tracker a URL belongs to is a judgement only the providers can make,
   * and two of them recognising the same string is a real state (a bare `PROJ-12` is both a Jira
   * key and a Linear identifier). The action reports that as a question rather than picking, so
   * the ordering of the registry can never decide which tracker a person's issue came from.
   */
  matchIssueSources(workspaceId: string, ref: string): Promise<AssistantIssueMatch[]>
  /** Fetch the issue and upsert its local projection. */
  importIssue(workspaceId: string, source: TaskSourceKind, ref: string): Promise<SourceTask>
  /** Materialise an imported issue as a board task inside a container, linked to the issue. */
  createTaskFromIssue(input: {
    workspaceId: string
    containerId: string
    source: TaskSourceKind
    externalId: string
    editor: BlockEditAuthority
    createdBy: string | null
  }): Promise<{ block: Block }>
}

/** Everything the built-in catalog is assembled from. */
export interface AssistantActionDeps {
  board: AssistantBoardDeps
  repos?: AssistantRepoDeps
  issues?: AssistantIssueDeps
}
