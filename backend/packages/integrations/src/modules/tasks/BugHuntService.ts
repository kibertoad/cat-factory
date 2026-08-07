import type { BlockEditAuthority } from '@cat-factory/contracts'
import type {
  BugCandidate,
  BugHuntAnalysisStatus,
  BugHuntAssessor,
  BugHuntCandidate,
  BugHuntResult,
  IssueIntakeQuery,
  RunBugHuntInput,
  TaskConnectionRepository,
  TaskRepository,
  TaskSourceKind,
  TaskSourceRegistry,
  TrackerBoard,
} from '@cat-factory/kernel'
import {
  ValidationError,
  parseBugHuntVerdicts,
  rankBugCandidates,
  redactSecrets,
} from '@cat-factory/kernel'
import type { TaskSourceReadReason } from '@cat-factory/contracts'
import type { TaskImportService } from './TaskImportService.js'
import type { TaskFromIssue, TaskLinkService } from './TaskLinkService.js'

// BugHuntService: the read-and-rank half of the interactive bug hunt — the human-driven dual
// of the recurring `bug-intake` step (`BugIntakeService`), and deliberately its structural
// twin: resolve the source's credentials, push every predicate into ONE vendor query, dedupe
// against the tasks projection with a single batched read, and hand back an outcome the
// caller finishes with.
//
// Where the two differ is who decides. Intake picks the oldest matching issue and claims it
// unattended; a hunt reads a whole board's worth of open, UNASSIGNED bugs, asks a model to
// rate impact against implementation complexity, and returns the ranked list for a human to
// choose from. Nothing is claimed, written or started until they confirm — `adopt` is the
// only method here with a side effect.
//
// Everything is provider-neutral (the kernel `listBoards` / `listBugCandidates` ports plus the
// shared import/link services) and stateless, so it runs identically on every runtime with no
// persistence of its own.

export interface BugHuntServiceDependencies {
  taskSourceRegistry: TaskSourceRegistry
  taskConnectionRepository: TaskConnectionRepository
  taskRepository: TaskRepository
  importService: TaskImportService
  linkService: TaskLinkService
  /**
   * The ranking model. Absent (or disabled) ⇒ a hunt still returns the board's candidates,
   * flagged `analysisStatus: 'unavailable'` — the read is useful on its own, and silently
   * presenting an unranked list as a ranking would be the one genuinely misleading outcome.
   */
  assessor?: BugHuntAssessor
  /**
   * The workspace spend safeguard, as the narrow predicate the ranking needs (so this layer
   * takes no dependency on `@cat-factory/spend`).
   *
   * A hunt is the platform's first BILLABLE model call that is not behind a run start, so the
   * budget check `RunAdmission` performs for a run has no equivalent here unless it is made
   * one: without it, a workspace that has exhausted its budget — and can therefore no longer
   * start the very run a hunt exists to start — could still spend on ranking, repeatedly.
   * Unwired ⇒ no guard, exactly as an unwired spend service means no guard on a run.
   */
  isOverBudget?: (workspaceId: string) => Promise<boolean>
}

/**
 * How many candidates one hunt scans. Bounded because the whole set goes into a single
 * ranking prompt: past this the prompt cost grows without making the shortlist better, since
 * a human is only ever going to look at the top handful. A board with more matching bugs
 * reports `truncated`, so the UI can say the scan was partial rather than implying the board
 * was exhausted.
 */
export const BUG_HUNT_SCAN_LIMIT = 40

/** The tracker default when the caller names no issue type — the same one intake uses. */
const DEFAULT_ISSUE_TYPE = 'bug'

export class BugHuntService {
  constructor(private readonly deps: BugHuntServiceDependencies) {}

  /**
   * List the boards a hunt can run against. A source whose provider can't enumerate boards
   * throws rather than returning `[]`: an empty picker and "this tracker cannot list boards"
   * look identical to a user, and only the second one tells them to type the board in.
   */
  async listBoards(workspaceId: string, source: TaskSourceKind): Promise<TrackerBoard[]> {
    const provider = this.deps.taskSourceRegistry.get(source)
    if (!provider?.listBoards) {
      // `reason` is what the SPA acts on: "this tracker cannot enumerate boards" is the ONE
      // failure whose answer is "type the board in yourself", and it must be distinguishable
      // from an unreachable tracker or an expired token — which would otherwise present as the
      // same free-text field, followed by a hunt that fails for a reason nobody was told.
      throw new ValidationError(`The '${source}' source cannot list boards on this deployment.`, {
        reason: 'boards_unsupported' satisfies TaskSourceReadReason,
      })
    }
    const credentials = await this.credentialsFor(workspaceId, source)
    return provider.listBoards(credentials, workspaceId)
  }

  /**
   * Run a hunt: read the board's open, unassigned bugs (excluding anything already linked to a
   * block), rank them, and return them best-first.
   *
   * The READ throws — an unreachable tracker is a failure the user must see, not an empty
   * board. The RANKING never does: an assessment that fails leaves the real candidates in
   * place under `analysisStatus: 'failed'`, because the list is independently useful and a
   * model outage should not cost the user the scan.
   */
  async hunt(
    workspaceId: string,
    source: TaskSourceKind,
    input: RunBugHuntInput,
  ): Promise<BugHuntResult> {
    const provider = this.deps.taskSourceRegistry.get(source)
    if (!provider?.listBugCandidates) {
      throw new ValidationError(`The '${source}' source cannot back a bug hunt on this deployment.`)
    }
    const credentials = await this.credentialsFor(workspaceId, source)

    // Exclusion list: every issue from this source currently imported AND linked to a block is
    // already being worked, so offering it as a fresh candidate would invite two runs on one
    // bug. ONE batched projection read, filtered in memory — never a per-candidate lookup.
    const projected = await this.deps.taskRepository.listByWorkspace(workspaceId)
    const excludeExternalIds = projected
      .filter((t) => t.linkedBlockId && t.source === source)
      .map((t) => t.externalId)

    const query: IssueIntakeQuery = {
      board: boardScopeFor(source, input.board),
      ...(input.titleFragment ? { titleFragment: input.titleFragment } : {}),
      ...(input.labels?.length ? { labels: input.labels } : {}),
      issueType: input.issueType || DEFAULT_ISSUE_TYPE,
      unassignedOnly: true,
      excludeExternalIds,
      // Ask for ONE past the cap purely to learn whether the board holds more. Comparing the
      // returned count against the cap instead cannot tell "exactly 40 bugs, all of them here"
      // from "40 shown, more behind them", and would tell a user their board holds more than
      // they can see whenever it holds exactly the cap.
      limit: BUG_HUNT_SCAN_LIMIT + 1,
    }
    const found = await provider.listBugCandidates(credentials, query, workspaceId)
    const truncated = found.length > BUG_HUNT_SCAN_LIMIT
    const candidates = truncated ? found.slice(0, BUG_HUNT_SCAN_LIMIT) : found

    const { ranked, analysisStatus, model } = await this.rank(workspaceId, candidates)
    return {
      source,
      board: input.board,
      analysisStatus,
      model,
      candidates: ranked,
      scanned: candidates.length,
      truncated,
    }
  }

  /**
   * Adopt a confirmed candidate: import the issue into the projection and materialise it as a
   * `bug` task inside `containerId`, with the issue linked for agent context.
   *
   * Stops there deliberately. Starting the run needs the execution engine (and the initiator's
   * personal-credential gate), which is the HTTP layer's job — this service stays inside the
   * integrations layer, exactly as `BugIntakeService` hands its pickup back to the engine.
   *
   * `editor` travels beside `createdBy` and is the same person: an adoption is a member-tier board
   * write, and the run it leads to is an ATTRIBUTED start (`runInitiatorRole`). The two answers
   * have to agree, or a tier sandboxed for its runs could still author the task those runs are
   * governed by (ADR 0037).
   */
  async adopt(input: {
    workspaceId: string
    source: TaskSourceKind
    externalId: string
    containerId: string
    editor: BlockEditAuthority
    createdBy: string | null
    pipelineId: string
  }): Promise<TaskFromIssue> {
    const { workspaceId, source, externalId, containerId, editor, createdBy, pipelineId } = input
    await this.deps.importService.import(workspaceId, source, externalId)
    return this.deps.linkService.createTaskFromIssue({
      workspaceId,
      containerId,
      source,
      externalId,
      editor,
      createdBy,
      // A hunted issue is a bug by construction, and the pipeline the human confirmed is the
      // one the task's Run controls should default to — so the created task carries both
      // rather than landing as a generic `feature` the user has to re-classify.
      shape: { taskType: 'bug', pipelineId },
    })
  }

  /**
   * Rank a candidate set, degrading to the unranked list with a stated reason. The model's
   * verdicts are joined onto the provider's rows by `rankBugCandidates`, so a hallucinated
   * issue is dropped and a skipped one surfaces as "not assessed" rather than as a zero.
   */
  private async rank(
    workspaceId: string,
    candidates: BugCandidate[],
  ): Promise<{
    ranked: BugHuntCandidate[]
    analysisStatus: BugHuntAnalysisStatus
    model: string | null
  }> {
    const unranked = rankBugCandidates(candidates, new Map())
    if (candidates.length === 0) {
      return { ranked: unranked, analysisStatus: 'empty', model: null }
    }
    const assessor = this.deps.assessor
    if (!assessor?.enabled) {
      return { ranked: unranked, analysisStatus: 'unavailable', model: null }
    }
    try {
      // Checked BEFORE the call, and reported as its OWN status rather than folded into
      // `failed`: an exhausted budget is not a broken model, and the fix (raise the budget, or
      // wait for the window to roll) is not the fix for a revoked key.
      //
      // Inside the try because it reads the spend ledger: a probe that cannot answer must not
      // cost the user the scan they already paid a vendor call for. It then degrades to
      // `failed` — accurate (the rating could not be completed) and fail-CLOSED (no model call
      // is made), which is the only safe direction for a budget guard.
      if (await this.deps.isOverBudget?.(workspaceId)) {
        return { ranked: unranked, analysisStatus: 'over_budget', model: null }
      }
      // Bug bodies are written by anyone who can file a ticket and are about to be sent to a
      // model provider, so they are scrubbed BEFORE they leave the deployment — the same
      // boundary the agent-context snapshots apply, for the same reason.
      const { verdicts, model } = await assessor.assess({
        workspaceId,
        candidates: candidates.map(scrubCandidate),
      })
      return {
        ranked: rankBugCandidates(candidates, parseBugHuntVerdicts(verdicts)),
        analysisStatus: 'ranked',
        model,
      }
    } catch {
      // Deliberately swallowed: `analysisStatus: 'failed'` is what the user acts on, and the
      // scan they paid for is still in the response. The assessor logs the underlying cause.
      // A budget probe that threw lands here too — nothing was spent, and the scan survives.
      return { ranked: unranked, analysisStatus: 'failed', model: null }
    }
  }

  /** Resolve a source's stored credentials, or an empty bag for a credentialless one (GitHub). */
  private async credentialsFor(
    workspaceId: string,
    source: TaskSourceKind,
  ): Promise<Record<string, string>> {
    const connection = await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
    return connection?.credentials ?? {}
  }
}

/**
 * Put the caller's board id on the field the target provider reads. The three built-in vendors'
 * board notions are structurally different (a Jira project key, a Linear team UUID, an
 * `owner/repo` slug), which is exactly why the wire carries ONE opaque string and the mapping
 * happens here rather than in the SPA — a picker that had to know which field to fill would have
 * to be forked per provider.
 *
 * A DEPLOYMENT-REGISTERED source takes the opaque `boardId` leg. It must not fall through to
 * `githubRepo`: every field here is a plain string, so a fall-through would hand a registered
 * provider's board scope to the GitHub field and fail as "no matching issues" rather than as the
 * mis-routing it is. The default is therefore keyed on the source being a BUILT-IN, not on it
 * being un-matched.
 */
function boardScopeFor(source: TaskSourceKind, board: string): IssueIntakeQuery['board'] {
  if (source === 'jira') return { jiraProjectKey: board }
  if (source === 'linear') return { linearTeamId: board }
  if (source === 'github') return { githubRepo: board }
  return { boardId: board }
}

/** Scrub the free-text fields of a candidate before it is sent to a model provider. */
function scrubCandidate(candidate: BugCandidate): BugCandidate {
  return {
    ...candidate,
    title: redactSecrets(candidate.title) ?? '',
    description: redactSecrets(candidate.description) ?? '',
  }
}
