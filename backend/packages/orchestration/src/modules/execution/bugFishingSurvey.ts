import { safeParseBlueprintService } from '@cat-factory/contracts'
import type { BlueprintService, BugFishingTerritory, Logger, RepoFiles } from '@cat-factory/kernel'
import { describeError, noopLogger } from '@cat-factory/kernel'
import { type SurveyedFile, partitionCodebase } from './bugFishingTerritories.logic.js'

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

/** Where the Blueprinter commits its decomposition, relative to the service root. */
const BLUEPRINT_PATH = 'blueprints/blueprint.json'

/** What a survey produced, plus what it could not do. */
export interface CodebaseSurveyResult {
  /** The partition, most worth fishing first once the caller has prioritised it. */
  territories: BugFishingTerritory[]
  /** Every fishable file of each territory, for the manifest and the coverage intersection. */
  filesByTerritory: Map<string, SurveyedFile[]>
  /** True when the provider cut the tree short: the territories cover a PREFIX of the codebase. */
  treeTruncated: boolean
  /**
   * Why the survey could not read the codebase, when it could not. Null on a real survey.
   *
   * Stated rather than left as a one-territory plan, because the two are the same VALUE and
   * opposite FACTS: "this repository is small enough to fish whole" and "nobody could see this
   * repository" would otherwise render identically, and the second is the one a human has to act
   * on.
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
 */
function unavailable(reason: string): CodebaseSurveyResult {
  return {
    territories: [],
    filesByTerritory: new Map(),
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
    return unavailable('No repository is linked to this task, so the codebase was not surveyed.')
  if (!repo.listTree) {
    return unavailable(
      'The connected VCS client cannot list a repository tree, so the codebase was not surveyed.',
    )
  }
  let tree
  try {
    tree = await repo.listTree(input.branch)
  } catch (error) {
    log.warn('bugFishing.treeReadFailed', { branch: input.branch, ...describeError(error) })
    return unavailable('The repository tree could not be read, so the codebase was not surveyed.')
  }
  const blueprint = await readBlueprint(repo, input.branch, input.serviceDirectory, log)
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
 * The service's committed blueprint, or null.
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
  serviceDirectory: string | null | undefined,
  log: Logger,
): Promise<BlueprintService | null> {
  const root = (serviceDirectory ?? '').replace(/^\/+|\/+$/g, '')
  const path = root ? `${root}/${BLUEPRINT_PATH}` : BLUEPRINT_PATH
  try {
    const file = await repo.getFile(path, branch)
    if (!file?.content) return null
    return safeParseBlueprintService(JSON.parse(file.content)) ?? null
  } catch (error) {
    log.warn('bugFishing.blueprintReadFailed', { path, ...describeError(error) })
    return null
  }
}
