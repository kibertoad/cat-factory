import { BLUEPRINT_JSON_PATH, safeParseBlueprintService } from '@cat-factory/contracts'
import type {
  BlueprintService,
  BugFishingTerritory,
  Logger,
  RepoFiles,
  RunRepoContext,
} from '@cat-factory/kernel'
import { describeError, noopLogger } from '@cat-factory/kernel'
import {
  type SurveyedFile,
  partitionCodebase,
  wholeCodebaseTerritory,
} from './bugFishingTerritories.logic.js'

// ---------------------------------------------------------------------------
// The CODEBASE SURVEY a bug-fishing expedition plans from: one checkout-free read of the
// repository tree, partitioned into territories.
//
// It is the only impure half of the territory design. Everything it decides lives in
// `bugFishingTerritories.logic.ts` as a pure reduction; this module reads the tree, reads the
// committed blueprint when there is one, and reports honestly when it could read neither.
//
// The read goes through `RepoFiles.listTree`, which is cached per `(installation, repo, ref)`, so
// every one of an expedition's dispatches shares ONE tree read of the branch they all fish. It is
// re-run per dispatch rather than persisted, because the persisted record holds territory
// DESCRIPTORS and never file lists: a thousand paths per territory on a run blob re-serialised on
// every progress write is exactly the growth the design refuses.
// ---------------------------------------------------------------------------

/** What a survey produced, plus what it could not do. */
export interface CodebaseSurveyResult {
  /** The partition, most worth fishing first once the caller has prioritised it. */
  territories: BugFishingTerritory[]
  /**
   * Every fishable file of each territory, for the manifest and the coverage intersection. Paths
   * are relative to the SURVEY ROOT (the service's own directory in a monorepo), which is the
   * frame the agent's checkout is rooted at.
   */
  filesByTerritory: Map<string, SurveyedFile[]>
  /** True when the provider cut the tree short: the territories cover a PREFIX of the codebase. */
  treeTruncated: boolean
  /**
   * Why the survey could not read the codebase, when it could not. Null on a real survey.
   *
   * Stated rather than left for the one-territory plan to imply, because the plan is the same
   * VALUE for opposite FACTS: "this repository is small enough to fish whole" and "nobody could
   * see this repository" produce an identical partition, and only the second is something a human
   * has to act on.
   */
  unavailableReason: string | null
}

/** What the survey needs to read a codebase. */
export interface CodebaseSurveyInput {
  /**
   * The run's checkout-free repo facade, or null when no repository resolves for the block (no
   * VCS connected, or the deployment wires no repo context).
   */
  repo: RepoFiles | null
  /** The branch the expedition fishes: the base branch its read-only clone is taken from. */
  branch: string
  /** The monorepo subdirectory the service lives in, when it has one. */
  serviceDirectory?: string | null
  logger?: Logger
}

/**
 * The survey a caller gets when the codebase cannot be read: ONE whole-codebase territory,
 * carrying the reason.
 *
 * A pass-through is the correct disposition for an unwired capability, and it must be invisible
 * to the domain: the expedition this plans is byte-for-byte the eight-angle hunt that shipped
 * before territories existed. What it must not be is silent, which is what `reason` is for.
 *
 * ONE territory rather than none, and the difference is not cosmetic: an empty list is what the
 * step then persists as `territories: []`, the value the schema documents as forbidden because it
 * claims the codebase was surveyed and found to contain nothing, and it is also what leaves the
 * planner with no cell to name when the pass budget cuts an angle. The territory's counts are
 * zero because nobody could count them; `unavailableReason` is what says so, and it is the only
 * thing that tells this apart from a genuinely tiny repository.
 *
 * Exported because the seam that RESOLVES the run's repository sits outside this module and can
 * fail on its own terms (an unlinked block chain refuses with a `ValidationError`), and this
 * module's contract is that a survey never throws. That caller states its own reason through here
 * rather than rebuilding the shape.
 */
export function unavailableSurvey(reason: string): CodebaseSurveyResult {
  const only = wholeCodebaseTerritory([])
  return {
    territories: [only],
    filesByTerritory: new Map([[only.id, []]]),
    treeTruncated: false,
    unavailableReason: reason,
  }
}

/**
 * Read the repository tree and partition it into territories.
 *
 * Never throws: a tree read that fails degrades to the whole-codebase expedition WITH the cause
 * recorded, because an expedition that cannot be partitioned is still worth running and a run
 * that failed at planning because a contents API blipped is not. The blueprint read degrades the
 * same way, one level finer: no blueprint means the directory heuristic, which is what a
 * repository that was never blueprinted gets anyway.
 */
export async function surveyCodebase(input: CodebaseSurveyInput): Promise<CodebaseSurveyResult> {
  const log = input.logger ?? noopLogger
  const repo = input.repo
  if (!repo)
    return unavailableSurvey(
      'No repository is linked to this task, so the codebase was not surveyed.',
    )
  if (!repo.listTree) {
    return unavailableSurvey(
      'The connected VCS client cannot list a repository tree, so the codebase was not surveyed.',
    )
  }
  let tree
  try {
    tree = await repo.listTree(input.branch)
  } catch (error) {
    log.warn('bugFishing.treeReadFailed', { branch: input.branch, ...describeError(error) })
    return unavailableSurvey(
      'The repository tree could not be read, so the codebase was not surveyed.',
    )
  }
  const blueprint = await readBlueprint(repo, input.branch, log)
  const survey = partitionCodebase(tree, {
    serviceDirectory: input.serviceDirectory ?? null,
    blueprint,
  })
  return {
    territories: survey.territories,
    filesByTerritory: survey.filesByTerritory,
    treeTruncated: survey.treeTruncated,
    unavailableReason: null,
  }
}

/**
 * Survey the codebase a RUN targets: resolve its repository, then partition the tree.
 *
 * The repo resolution is its own refusal and does not belong to a survey. An unlinked block chain
 * throws a `ValidationError` rather than answering null, deliberately, because guessing a repo once
 * pushed a task into someone else's; that refusal belongs to a DISPATCH, where a human can act on
 * it. This module's contract is the opposite one, that a survey never throws, and its callers
 * include the COMPLETION path of a pass that has already run and has nothing left to refuse.
 *
 * Here rather than on the dispatcher so the two halves of "never throws" sit together, and so the
 * dispatcher keeps only the binding: which repo resolver, which logger.
 */
export async function surveyRunCodebase(input: {
  /** The run's repo resolution, bound to one workspace and block by the caller. */
  resolveRunRepo: () => Promise<RunRepoContext | null>
  /** Bind the block id on it: everything below logs into this scope. */
  logger?: Logger
}): Promise<CodebaseSurveyResult> {
  const log = input.logger ?? noopLogger
  let runRepo: RunRepoContext | null
  try {
    runRepo = await input.resolveRunRepo()
  } catch (error) {
    log.warn('bugFishing.repoResolveFailed', describeError(error))
    return unavailableSurvey(
      'The repository this task targets could not be resolved, so the codebase was not surveyed.',
    )
  }
  return surveyCodebase({
    repo: runRepo?.repo ?? null,
    branch: runRepo?.baseBranch ?? 'HEAD',
    serviceDirectory: runRepo?.serviceDirectory ?? null,
    logger: log,
  })
}

/**
 * The service's committed blueprint, or null.
 *
 * Read at the REPOSITORY root, because that is where `blueprintPostOp` commits it: the post-op
 * writes {@link BLUEPRINT_JSON_PATH} through a root-scoped `RepoFiles`, with no service prefix,
 * whatever subdirectory the service that produced it lives in. Reading it under the service
 * directory found nothing on every monorepo service, and found it silently: a blueprinted service
 * fell through to the directory heuristic with nothing saying it had one. The constant is imported
 * rather than restated so the reader cannot drift from the writer again.
 *
 * The blueprint is a DECOMPOSITION first and a file map second: its `references` were written by
 * a model against an older tree, so the partition drops a reference the tree no longer has rather
 * than trusting it, and a blueprint that parses to nothing usable is simply no blueprint. A read
 * failure is the same answer for the same reason: the directory heuristic is a complete fallback,
 * not a degraded one.
 */
async function readBlueprint(
  repo: RepoFiles,
  branch: string,
  log: Logger,
): Promise<BlueprintService | null> {
  try {
    const file = await repo.getFile(BLUEPRINT_JSON_PATH, branch)
    if (!file?.content) return null
    return safeParseBlueprintService(JSON.parse(file.content)) ?? null
  } catch (error) {
    log.warn('bugFishing.blueprintReadFailed', {
      path: BLUEPRINT_JSON_PATH,
      ...describeError(error),
    })
    return null
  }
}
