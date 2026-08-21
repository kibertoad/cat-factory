import type { AgentDispatchContext, AgentRunContext } from '@cat-factory/kernel'
import { TRIAGE_JSON_CONTRACT } from './roles.js'

// ---------------------------------------------------------------------------
// The task prompts + structured-output shape hints for the BUILT-IN container kinds that assess
// rather than produce (`merger`, `on-call`) and for the tester family's reply shape.
//
// They lived in `@cat-factory/server`'s `agents/prompts.ts` while those kinds were rendered by a
// `switch (context.agentKind)` in the job-body builder. They live here now for the reason the
// blueprints/spec-writer prompts moved: a registered kind's prompts are resolved through
// `systemPromptFor` / `userPromptFor`, which sit in this package, so a prompt left in the HTTP
// layer could not be reached by a registration.
//
// What made these the LAST built-ins to migrate: their text has to name a BRANCH, and the run
// context describes the work rather than the checkout. That is the {@link AgentDispatchContext}
// seam — passed to a kind's own prompt builder on a container dispatch, absent for an inline
// caller, which is why each builder below phrases itself without branch names when it gets none
// rather than inventing one.
// ---------------------------------------------------------------------------

/** Compact shape hint fed to the structured-output repair call for the merger assessment. */
export const MERGE_ASSESSMENT_SHAPE_HINT =
  'Expected a merge assessment: {"complexity": number 0..1, "risk": number 0..1, ' +
  '"impact": number 0..1, "rationale": string}.'

/** Compact shape hint fed to the structured-output repair call for the on-call assessment. */
export const ON_CALL_ASSESSMENT_SHAPE_HINT =
  'Expected an on-call assessment: {"culpritConfidence": number 0..1, "recommendation": ' +
  '"revert"|"hold"|"monitor", "rationale": string, "evidence": string[]}.'

/** Compact shape hint fed to the structured-output repair call for the tester report. */
export const TEST_REPORT_SHAPE_HINT =
  'Expected a test report: {"greenlight": boolean, "summary": string, "tested": string[], ' +
  '"outcomes": [{"name": string, "status": "passed"|"failed"|"skipped", "detail"?: string}], ' +
  '"concerns": [{"title": string, "detail": string, "severity": "low"|"medium"|"high"|"critical"}]}.'

/** Shape hint for the UI tester: a test report that also lists captured screenshots. */
export const UI_TEST_REPORT_SHAPE_HINT =
  TEST_REPORT_SHAPE_HINT.replace(/\}\.$/, '') +
  ', "screenshots": [{"view": string, "artifactId": string, "hash"?: string}]}. Each ' +
  'screenshot must be a distinct view you captured and uploaded to the artifact store.'

/** The closing JSON instruction both assessment kinds end on, stated once. */
const MERGE_JSON_INSTRUCTION =
  'Respond with ONLY a JSON object {"complexity":0.0,"risk":0.0,"impact":0.0,"rationale":"…"}.'

/**
 * The merger's task prompt: assess the pull request's diff against its base and return the
 * complexity / risk / impact scores as JSON. The engine performs the real merge from the scores;
 * the agent never merges anything itself.
 *
 * On a MULTI-REPO task (service-connections phase 4) the change is one PR per repo, each checked
 * out as a read-only sibling on its PR branch. The exact per-repo diff commands + sibling
 * directories live in the "Multi-repo pull request" system-prompt section the explore builder
 * appends, so that variant just tells the agent to run them and score the COMBINED change as ONE
 * assessment.
 */
export function mergerUserPrompt(
  context: AgentRunContext,
  dispatch?: AgentDispatchContext,
): string {
  if (dispatch?.multiRepo) return mergerMultiRepoUserPrompt(context)
  const prNumber = context.block.pullRequest?.number
  const pr = prNumber !== undefined ? ` (PR #${prNumber})` : ''
  // With no dispatch context there is no checkout and therefore no branch to name: say what to
  // diff without asserting a branch name the caller never resolved.
  const diffGuidance = dispatch
    ? `The pull request${pr} is on branch \`${context.block.pullRequest?.branch ?? dispatch.baseBranch}\`; ` +
      `the base branch is \`${dispatch.baseBranch}\`. Inspect the change (e.g. ` +
      `\`git fetch origin ${dispatch.baseBranch}\` then \`git diff origin/${dispatch.baseBranch}...HEAD\`) ` +
      `and score complexity, risk and impact.`
    : `Score the pull request${pr}'s change for complexity, risk and impact from the evidence you ` +
      'have been given.'
  return [
    'Assess the pull request on the head branch against the base branch and return the ' +
      'complexity / risk / impact scores + rationale as JSON.',
    '',
    diffGuidance,
    '',
    MERGE_JSON_INSTRUCTION,
  ].join('\n')
}

/** The merger's task prompt for a MULTI-REPO task — see {@link mergerUserPrompt}. */
function mergerMultiRepoUserPrompt(context: AgentRunContext): string {
  return [
    'This pull request spans MULTIPLE repositories — see the "Multi-repo pull request" section in ' +
      'your instructions for each repository, its sibling directory, and the diff command to run.',
    '',
    'Run every per-repo diff, then assess the COMBINED change as one unit: its overall complexity, ' +
      'the risk of the coordinated cross-repo change, and its combined blast radius. Return a SINGLE ' +
      'assessment covering all repositories (not one per repo).',
    '',
    `Task: ${context.block.title}`,
    '',
    MERGE_JSON_INSTRUCTION,
  ].join('\n')
}

/**
 * The on-call agent's closing task instructions, APPENDED to the generic block-context prompt
 * (which carries the regression evidence and the prior steps' output). The released PR has
 * already merged into the base branch and its work branch is gone, so the agent is on the base
 * branch and is told how to find the merged commit.
 *
 * A SUFFIX rather than a replacement precisely because the evidence above it is the input: the
 * generic prompt is what makes this a regression investigation rather than a code read.
 */
export function onCallUserPromptSuffix(
  context: AgentRunContext,
  dispatch?: AgentDispatchContext,
): string {
  const prNumber = context.block.pullRequest?.number
  const headBranch = context.block.pullRequest?.branch
  const pr = prNumber !== undefined ? `#${prNumber}` : ''
  const locate = prNumber
    ? `It merged as a commit referencing ${pr} — find it with \`git log --oneline -n 50\` ` +
      `(squash/merge commits include \`(${pr})\`; a merge commit mentions \`#${prNumber}\`), then ` +
      `inspect it with \`git show <sha>\`.`
    : headBranch
      ? `Its work branch was \`${headBranch}\` (now deleted) — find the merged commit in ` +
        `\`git log --oneline -n 50\` and inspect it with \`git show <sha>\`.`
      : `Find the most recent merge/feature commit with \`git log --oneline -n 50\` and inspect ` +
        `it with \`git show <sha>\`.`
  // Absent dispatch ⇒ no checkout was resolved, so name no branch and ask for no `git`.
  const where = dispatch
    ? `You are on the base branch \`${dispatch.baseBranch}\`, which already contains the released ` +
      `pull request ${pr}. ${locate} `
    : `The released pull request ${pr} is already merged into the base branch. `
  return [
    `${where}Correlate that change with the regression evidence above. ` +
      'Beware correlation vs causation.',
    '',
    'Respond with ONLY a JSON object {"culpritConfidence":0.0,"recommendation":"revert"|"hold"|"monitor","rationale":"…","evidence":["…"]}.',
  ].join('\n')
}

/**
 * The `task-reassessor`'s task prompt: read the change the run actually landed and score the
 * three triage axes against it.
 *
 * The checkout is the pr-reviewer's: the BASE branch plus the pull request's head fetched as
 * `origin/pr-head` by the harness. That shape rather than a clone of the PR branch because the
 * branch is DELETED once the pull request merges, while `refs/pull/<n>/head` survives it, so the
 * same step reads the same diff whether it runs before the merge or after it.
 *
 * It is NOT handed the earlier forecast (see the role prompt in ./roles.ts): the platform derives
 * the delta from the two records rather than asking the model what it changed.
 *
 * A MULTI-REPO task is named rather than silently under-scored. The peer PRs' repositories are not
 * in this checkout (resolving them is the merger's combined-diff path, which is that kind's alone),
 * so the assessment covers the primary repository's change and has to SAY so, or a reader takes a
 * partial score for the whole one.
 */
export function taskReassessorUserPrompt(
  context: AgentRunContext,
  dispatch?: AgentDispatchContext,
): string {
  const prNumber = context.block.pullRequest?.number
  const pr = prNumber !== undefined ? ` (PR #${prNumber})` : ''
  // With no dispatch context there is no checkout and therefore no branch to name: say what to
  // read without asserting a branch name the caller never resolved.
  const readGuidance = dispatch
    ? `You are on the base branch \`${dispatch.baseBranch}\`, and the change${pr} has been ` +
      'fetched for you as `origin/pr-head`:\n' +
      `  git diff --name-status origin/${dispatch.baseBranch}...origin/pr-head   # the shape of the change\n` +
      `  git diff origin/${dispatch.baseBranch}...origin/pr-head -- <path>       # one file's diff\n` +
      'Start from the shape, then read the diffs that decide the score. If `origin/pr-head` is ' +
      'absent (the fetch was skipped), say so in your rationale and score from the evidence above ' +
      'rather than guessing.'
    : `Score the change${pr} from the evidence you have been given.`
  const peers = context.block.peerPullRequests?.length ?? 0
  const scope =
    peers > 0
      ? `This task also changed ${peers} connected service repositor${peers === 1 ? 'y' : 'ies'}, ` +
        'which are NOT in this checkout. Score the change you can read, and state in your ' +
        'rationale that the connected repositories were out of scope.'
      : null
  return [
    'The implementation for this task has landed. Assess what was ACTUALLY built and return the ' +
      'complexity / risk / impact scores + rationale as JSON.',
    '',
    readGuidance,
    ...(scope ? ['', scope] : []),
    '',
    `Task: ${context.block.title}`,
    '',
    TRIAGE_JSON_CONTRACT,
  ].join('\n')
}

/**
 * The conflict-resolver's task prompt: a COMPACT task reference, deliberately NOT the generic
 * block-context prompt.
 *
 * That prompt renders the full task brief plus every prior agent's output (the spec-writer's
 * whole spec, and so on), which buries the one-line "resolve a conflict" role and drifts the
 * model onto re-implementing the feature. Observed in production: a resolver that returned a
 * "test report is ready" answer and never touched the conflict markers. The harness leads the
 * prompt with the actual conflict hunks it discovers, so intent is all the backend owes it.
 */
export function conflictResolverUserPrompt(context: AgentRunContext): string {
  const description = context.block.description?.trim()
  return `Task: ${context.block.title}${description ? `\n\n${description}` : ''}`
}
