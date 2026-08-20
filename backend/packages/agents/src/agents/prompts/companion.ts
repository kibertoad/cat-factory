import type { AgentDispatchContext, AgentKind, AgentRunContext } from '@cat-factory/kernel'
import { companionFor, isContainerBackedCompanion } from '../kinds/companions.js'
import type { AgentKindRegistry } from '../kinds/registry.js'
import {
  FINAL_ANSWER_IN_REPLY,
  FRAGMENT_ADHERENCE_GUIDANCE,
  REVIEW_FINDINGS_LAYOUT,
} from './shared.js'
import { anchoredQualityScale } from './review-rounds.js'

// System prompt for a companion agent, parameterised by the producer kind it
// reviews. The companion returns its findings as severity-graded `comments` plus a
// single overall quality rating (0..1) and a short verdict summary, all as JSON the
// engine validates with `companionAssessmentSchema`. The two halves are read
// independently: a `blocker` comment holds the step whatever the rating says.

/** The companion system prompt for `kind`, or undefined when `kind` is not a companion. */
export function companionSystemPrompt(
  kind: AgentKind,
  registry: AgentKindRegistry,
): string | undefined {
  const def = companionFor(kind, registry)
  if (!def) return undefined
  return [
    `You are a meticulous quality companion reviewing the ${def.reviews} produced by the`,
    `preceding ${def.targets.join(' / ')} step. Challenge it hard for correctness, quality,`,
    'completeness and risk: call out gaps, missing cases, weak or untestable points, and',
    'anything that would block confident downstream work. Then give a SINGLE overall quality',
    'rating between 0 and 1. Be a fair but demanding critic: do not rubber-stamp, and do not',
    'hunt for something to say when the work is sound.',
    '',
    // The SAME anchors the judge bucket scores on. Unanchored, "rate this 0..1" produces a
    // number drawn from the model's priors rather than from the work, which is what made a
    // rework loop's scores wander instead of climb: the step's `threshold` can only mean
    // something if two consecutive rounds mean the same thing by 0.8.
    anchoredQualityScale('the standard for this deliverable'),
    // The numeric bar is deliberately NOT named here, nor pointed at. It is a per-STEP operator
    // setting that `withGradingBar` states with the work, and that wrapper is absent on every
    // surface with no live companion loop to read one off — the prompt editor, the Sandbox
    // composing a graded candidate, a dispatch whose step carries no companion state. A sentence
    // here promising the number "below" is a dangling pointer on exactly those surfaces, which is
    // the same defect this prompt's own trait guidance is gated to avoid. The scale's anchors are
    // self-contained without it.
    //
    // A container-backed companion gets a real, read-only checkout of the producer's PR
    // branch. Reviewing the producer's summary reply alone is worthless — judge the ACTUAL
    // artifact: open and read the changed files / the full committed document and whatever
    // surrounding repository context you need to assess it properly. The preceding step's
    // reply (if any) is only a pointer; the repository on disk is the source of truth.
    //
    // It names no commands and points at none, for the same reason: `companionCheckoutSection`
    // WITHHOLDS them wherever they would describe a checkout that is not a change (a dispatch that
    // fell back to the base branch, a base ref that cannot be safely quoted). This instruction has
    // to stand on its own in those runs, so it states the rule rather than deferring to a section.
    ...(isContainerBackedCompanion(kind, registry)
      ? [
          '',
          'You have a read-only checkout of the branch under review, with full history.',
          'Do NOT judge from the summary alone: start from what actually changed, then open and',
          'read the changed files in full, plus any related code or documents in the repository',
          'you need for context, before rating. Ground every comment in what the files actually',
          'contain. Make no commits.',
        ]
      : []),
    // The document reviewer carries `doc-aware`, so the engine folds the task's
    // writing-style fragments (anti-LLM-isms, concise & actionable) into this prompt under
    // "Follow these standards while doing the work". For a REVIEWER, those standards are the
    // criteria to hold the draft to — make that explicit so the same bodies serve as both
    // the writer's instruction and the reviewer's check.
    ...(kind === 'doc-reviewer'
      ? [
          '',
          'Any writing standards included below are the CRITERIA the document must meet: hold the',
          'draft to them and flag every violation (LLM tells, filler, hedging, passive or vague',
          'recommendations, bullet inflation) in your rating and comments.',
        ]
      : []),
    // The spec-writer only TRANSLATES the task requirements it was given into a spec
    // increment; inventing, completing, or deciding requirements is the requirements
    // step's job, not its. So judge only what the writer controls — fidelity to the
    // given requirements — and never fault it for requirements it was never given, for
    // cases the requirements did not call for, or for things the requirements put out
    // of scope. Those are gaps in the requirements, not the spec.
    ...(kind === 'spec-companion'
      ? [
          '',
          'Judge the specification ONLY against the task requirements it was given, and only',
          'on what the Spec Writer controls: faithful, complete TRANSLATION of those',
          'requirements into prescriptive "The system SHALL …" statements with Given/When/Then',
          'acceptance coverage. The writer does not invent, complete, or decide requirements.',
          'Concretely:',
          '- Cover the happy path for every behaviour the requirements state, plus ONLY the',
          '  error / edge / boundary cases the requirements explicitly call for or that a',
          '  stated requirement cannot be satisfied without. Do NOT demand error paths,',
          '  validation rules, status codes, or scenarios the requirements neither state nor',
          '  strictly require (e.g. not-found responses, malformed-input handling,',
          '  field-completeness policy): absent a requirement, those are gaps in the',
          '  requirements, not the spec.',
          "- Honour the requirements' own scope. If they mark something a non-goal, an",
          '  assumption, or an explicit exclusion / out of scope, do NOT fault the spec for',
          '  leaving it out — penalising that is reviewing the requirements, not the spec.',
          '- Never ask the writer to "clarify" or "decide" a question the requirements left',
          '  open; raising that belongs to the requirements step.',
          'Do NOT penalise the spec for requirements that were not part of its input or for',
          'resources / behaviour the task did not ask for. Treat the baseline spec it built',
          "on as given; only this task's increment is under review.",
          '',
          'BUSINESS vs TECHNICAL: the spec captures ONLY business requirements. For a purely',
          'technical task (a refactor, dependency bump, internal restructuring, build/infra or',
          'other non-functional change that does NOT alter externally-observable behaviour),',
          '"NO NEW SPECS" is the CORRECT outcome — the writer signals this with',
          '{"noBusinessSpecs": true} and leaves the baseline untouched. Do NOT fault an',
          'unchanged spec or demand invented requirements for such a task. Make an explicit',
          'determination and report it in `technicalCorroborated`: set it `true` when you agree',
          'the task is purely technical and rightly produced no business specs, and `false`',
          'when business requirements were warranted (whether or not the writer produced them).',
          'If you DISPUTE a "no new specs" claim for a task that does have business behaviour,',
          'raise it as a `blocker` comment naming the behaviour that needs specifying, so the',
          'writer is looped back on it.',
        ]
      : []),
    '',
    'Respond with ONLY a JSON object of shape',
    '{"rating":0.0,"summary":"…","comments":[{"severity":"blocker"|"major"|"minor",',
    '"body":"…","anchorId":"…"}]}: `rating` is the overall score, `summary` is your verdict on',
    'the work as a whole, and `comments` is one entry per point you raise, each graded by how',
    'urgently it must be fixed. `anchorId` is optional and only applies where the reviewed',
    'output is structured (e.g. a spec requirement / acceptance-criterion id).',
    'THE TWO ARE READ SEPARATELY: the rating decides whether the work as a whole meets the bar,',
    'and any `blocker` comment sends it back to be fixed regardless of that rating. So grade the',
    'work honestly on the scale above rather than lowering the rating to force a fix, and raise',
    'a `blocker` for anything that must not proceed rather than hoping a low rating conveys it.',
    ...(kind === 'spec-companion'
      ? ['Include `technicalCorroborated` (true/false) as described above.']
      : []),
    // The code reviewer additionally reports how well the change adheres to each best-practice
    // standard folded into its prompt (a `fragmentAdherence` array) — see the guidance appended
    // below. Only the code `reviewer` does this; the other companions review different artifacts.
    ...(kind === 'reviewer' ? ['Include a `fragmentAdherence` array as described below.'] : []),
    'No prose outside the JSON, no code fences.',
    // `comments` + `summary` together ARE the review: nothing else on the step carries the
    // findings, and the severities are what the engine reads to decide whether the run moves on.
    // So the shape of both, and what each severity commits to, gets said here.
    '',
    REVIEW_FINDINGS_LAYOUT,
    ...(kind === 'reviewer' ? ['', FRAGMENT_ADHERENCE_GUIDANCE] : []),
    '',
    FINAL_ANSWER_IN_REPLY,
  ].join('\n')
}

/**
 * A branch name safe to interpolate into a shell command and a markdown code span.
 *
 * The base branch is PROVIDER-supplied, and git permits far more in a ref than a shell does: a
 * backtick closes the code span and reflows the rest of this section as prose, and `$(…)` in a
 * command the agent is told to run is a substitution the agent's own shell tool performs. Model-
 * and provider-authored strings that become git arguments are validated for MAGIC rather than
 * merely for traversal, so this is an ALLOW-list of what a ref may contain, not a deny-list of
 * what bites. Leading `-` is excluded separately: it turns the name into an option.
 */
const SAFE_BRANCH_NAME = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/

/**
 * Where a container-backed companion's review STARTS: the refs its checkout actually has, the two
 * commands that turn them into the change, and the rule that it plans from the shape before it
 * reads anything.
 *
 * The `pr-reviewer` has had this since it shipped, as an injected `.cat-context/pr-diff.md` its
 * prompt tells it to read first; the container-backed companions had nothing equivalent and were
 * told only to "diff against the base branch", which they had to first work out the name of. What
 * this states instead is what the DISPATCH resolved, which is the one thing the agent cannot
 * derive: `AgentDispatchContext.baseBranch` is the branch the engine forked from, and it is a
 * per-deployment fact (`main`, `master`, `develop`, a release line).
 *
 * A SECTION rather than an injected file, deliberately: a `.cat-context/pr-diff.md` would mean a
 * preOp reading the change back over HTTP to write bytes the checkout already has, and would
 * duplicate the diff into a prompt that is re-sent on every turn. The commands cost the reviewer
 * two turns and the output lands only in the turns that need it.
 *
 * No `git fetch` is named, and that is the point: the container agent holds NO git credential of
 * its own (the token lives with the harness and rides GIT_ASKPASS per harness-issued command), so
 * an agent-issued fetch fails outright on a private repo. The refs are the harness's job — a
 * companion dispatch clones with full history, which brings `origin/<base>` with it, and the
 * warm-pool path refreshes it (`exploreCheckoutRefs`). Naming a command the agent cannot run would
 * put an error on the very first instruction the review is anchored on.
 *
 * Returns `undefined` when there is no change to measure, which is every case the commands would
 * lie about:
 *   - a non-companion kind, or an INLINE companion (no checkout at all, so naming git commands
 *     would be the exact "things that are not true of this run" failure);
 *   - no resolved dispatch (a consensus panel participant: no filesystem, no tools);
 *   - a checkout that IS the base branch. A `clone.branch: 'pr'` dispatch falls back to base when
 *     the producer opened no pull request, and there `<base>...HEAD` is empty: the reviewer would
 *     be told to plan from a diffstat showing nothing and not to go looking past it, and would
 *     grade an empty change as the work;
 *   - a base branch whose name cannot be safely quoted, which is REPORTED rather than silently
 *     shortened: the section states the branch it could not name and stops, leaving the system
 *     prompt's own "start from what actually changed" instruction to stand.
 */
export function companionCheckoutSection(
  context: AgentRunContext,
  registry: AgentKindRegistry,
  dispatch?: AgentDispatchContext,
): string | undefined {
  if (!dispatch || !isContainerBackedCompanion(context.agentKind, registry)) return undefined
  const base = dispatch.baseBranch
  if (dispatch.checkoutBranch === base) return undefined
  if (!SAFE_BRANCH_NAME.test(base)) {
    return (
      '\nThis checkout is a change measured against the repository base branch. Its name contains ' +
      'characters this prompt cannot safely quote, so the diff commands are omitted here: derive ' +
      'the base ref yourself (`git branch -r`) before reading anything, and say in your summary ' +
      'that you had to.'
    )
  }
  const lines = [
    '',
    `The change under review is this checkout measured against \`${base}\`, the base branch it ` +
      'forked from. Establish the shape before you read anything:',
    `- \`git diff --stat origin/${base}...HEAD\` for which files moved and by how much.`,
    `- \`git diff origin/${base}...HEAD -- <path>\` for the change to a file or a directory.`,
    'Plan the review from that diffstat: it already tells you which files this change is about, so ' +
      'do not go looking for them. Read a changed file in full where the diff alone cannot settle ' +
      'whether it is correct, and read unchanged code where you need it for context.',
  ]
  if (dispatch.multiRepo) {
    lines.push(
      // What is true of a peer leg and no more. An explore peer carries `cloneBranch` only when the
      // caller pinned one (today only the merger's combined-diff builder does), so a peer is
      // otherwise checked out at its OWN default branch: claiming they share this branch would send
      // the reviewer to run a diff that resolves to nothing and read the emptiness as a verdict.
      'This change spans MULTIPLE repositories, each checked out as a sibling directory. Establish ' +
        "each one's own base the same way before you read it, and rate the COMBINED change as a " +
        'single verdict, not one per repository.',
    )
  }
  return lines.join('\n')
}
