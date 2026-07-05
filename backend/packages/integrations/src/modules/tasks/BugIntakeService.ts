import type {
  IssueIntakeQuery,
  PipelineScheduleRepository,
  TaskConnectionRepository,
  TaskRepository,
  TaskSearchResult,
  TaskSourceKind,
  TaskSourceRegistry,
} from '@cat-factory/kernel'
import { getErrorMessage } from '@cat-factory/kernel'
import type { TaskImportService } from './TaskImportService.js'
import type { TaskLinkService } from './TaskLinkService.js'
import { issueTaskDescription, issueTaskTitle } from './TaskLinkService.js'

// BugIntakeService: the read-and-claim half of the recurring `bug-intake` engine step
// (bug-triage pipeline design §3). Given the reused schedule block, it resolves the
// schedule's `issueIntake` config, searches the configured tracker board for the oldest
// OPEN issue matching the predicates (deduped against every issue already imported AND
// linked to a block — a single batched projection read, never a per-candidate lookup),
// imports the pick into the projection, and REPLACE-links it onto the block (dropping the
// previous fire's link so context never accumulates). It returns a pickup the engine
// finishes with — rewriting the block's title/description and posting the "taken by
// cat-factory" pickup writeback — or a `null` pickup when nothing qualified (the engine's
// no-op: skip the rest of the run, complete successfully).
//
// Everything here is provider-neutral: it drives the kernel `searchIssues` port + the shared
// import/link services, so it runs identically on every runtime that wires task sources.

export interface BugIntakeServiceDependencies {
  pipelineScheduleRepository: PipelineScheduleRepository
  taskSourceRegistry: TaskSourceRegistry
  taskConnectionRepository: TaskConnectionRepository
  importService: TaskImportService
  linkService: TaskLinkService
  taskRepository: TaskRepository
}

/** The issue an intake fire picked up, ready for the engine to seed the block + mark it claimed. */
export interface BugIntakePickup {
  source: TaskSourceKind
  externalId: string
  url: string
  /** Block title seeded from the issue (`PROJ-1: <title>`), mirroring `createTaskFromIssue`. */
  seedTitle: string
  /** Block description seeded from the issue (a source-reference line + the body). */
  seedDescription: string
  /** GitHub-only in-progress label (from the schedule); threaded to the pickup writeback. */
  inProgressLabel?: string
  /** Human-readable one-liner recorded as the step output (threaded to every later step). */
  summary: string
}

/**
 * The outcome of an intake fire: an issue was picked up, or nothing qualified. `picked: null`
 * covers no-configuration / an unsupported source / no matching issue / a tracker outage — all
 * of which the engine treats identically (no-op: complete the run without touching the block),
 * distinguished only by the `summary` recorded in the step output + run history.
 */
export type BugIntakeOutcome = { picked: BugIntakePickup } | { picked: null; summary: string }

/** The intake step picks exactly one issue, so a single oldest hit is all it needs. */
const INTAKE_LIMIT = 1
/** The tracker default when the schedule leaves `issueType` unset (design §3). */
const DEFAULT_ISSUE_TYPE = 'bug'

export class BugIntakeService {
  constructor(private readonly deps: BugIntakeServiceDependencies) {}

  /**
   * Resolve the schedule's intake config for `blockId`, pick the oldest matching open issue not
   * already worked, and import + replace-link it onto the block. Best-effort: any failure
   * (missing config, unsupported source, tracker outage) resolves to `{ picked: null }` with an
   * explanatory summary rather than throwing — a recurring run must never fail on a tracker hiccup,
   * and the next fire simply retries.
   */
  async pickForBlock(workspaceId: string, blockId: string): Promise<BugIntakeOutcome> {
    const schedule = await this.deps.pipelineScheduleRepository.getByBlock(workspaceId, blockId)
    const config = schedule?.issueIntake
    if (!config) {
      return { picked: null, summary: 'No issue-intake configuration on this schedule.' }
    }
    const provider = this.deps.taskSourceRegistry.get(config.source)
    if (!provider?.searchIssues) {
      return {
        picked: null,
        summary: `The '${config.source}' source cannot back issue intake on this deployment.`,
      }
    }

    // Exclusion list: every issue currently imported AND linked to a block for this source is off
    // limits — it is actively being worked. ONE batched projection read, filtered in memory — never
    // a per-candidate point lookup (the no-N+1 rule). The reused block's own previous-fire link is
    // included here (replace-link below drops it only AFTER the search), so the immediately-prior
    // pick is never re-selected on the very next fire.
    //
    // NOTE (scope): this excludes CURRENTLY-linked issues, not "ever worked" ones. Because
    // `replaceForBlock` unlinks the prior pick, a bug that was worked but LEFT OPEN (its fix PR
    // never merged, so the vendor `searchIssues` still returns it) can be re-picked a couple of
    // fires later. That is acceptable — an unmerged bug is unfinished, and a re-pick resumes it on
    // the same branch. A true "already resolved, never revisit" ledger would need a persisted
    // worked-issues table mirrored across both runtimes; deferred to a later phase rather than
    // faked here.
    const worked = await this.deps.taskRepository.listByWorkspace(workspaceId)
    const excludeExternalIds = worked
      .filter((t) => t.linkedBlockId && t.source === config.source)
      .map((t) => t.externalId)

    const query: IssueIntakeQuery = {
      board: config.board,
      ...(config.predicates.titleFragment
        ? { titleFragment: config.predicates.titleFragment }
        : {}),
      ...(config.predicates.labels?.length ? { labels: config.predicates.labels } : {}),
      issueType: config.predicates.issueType ?? DEFAULT_ISSUE_TYPE,
      excludeExternalIds,
      limit: INTAKE_LIMIT,
    }

    let hit: TaskSearchResult | undefined
    try {
      const credentials =
        (await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, config.source))
          ?.credentials ?? {}
      const hits = await provider.searchIssues(credentials, query, workspaceId)
      hit = hits[0]
    } catch (error) {
      return {
        picked: null,
        summary: `Issue search failed (${getErrorMessage(error)}); no issue picked up this fire.`,
      }
    }
    if (!hit) {
      return { picked: null, summary: 'No matching open issues to pick up.' }
    }

    // Import (projection upsert) then REPLACE-link onto the reused block: unlink whatever the
    // previous fire attached, then link this pick, so the block never accumulates stale context.
    try {
      await this.deps.importService.import(workspaceId, config.source, hit.externalId)
      await this.deps.linkService.replaceForBlock(
        workspaceId,
        blockId,
        config.source,
        hit.externalId,
      )
    } catch (error) {
      return {
        picked: null,
        summary: `Failed to import ${hit.externalId} (${getErrorMessage(error)}); no issue picked up.`,
      }
    }

    // Read the imported record back for the full body (search hits are lean) to seed the block.
    const record = await this.deps.taskRepository.get(workspaceId, config.source, hit.externalId)
    const seed = record ?? {
      externalId: hit.externalId,
      title: hit.title,
      url: hit.url,
      description: '',
    }
    return {
      picked: {
        source: config.source,
        externalId: hit.externalId,
        url: seed.url,
        seedTitle: issueTaskTitle(seed),
        seedDescription: issueTaskDescription(seed),
        ...(config.inProgressLabel ? { inProgressLabel: config.inProgressLabel } : {}),
        summary: `Picked up ${hit.externalId}: ${seed.title} (${seed.url}).`,
      },
    }
  }
}
