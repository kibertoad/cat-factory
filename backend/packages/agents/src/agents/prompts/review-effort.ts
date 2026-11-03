import type { ReviewEffortLevel } from '@cat-factory/contracts'
import { MAX_PARALLEL_SLICE_SUBAGENTS } from '../kinds/pr-reviewer.js'

// How a review's EFFORT LEVEL turns into instructions. The levels mirror Claude Code's
// `/code-review <level>`: `low` reports a few findings it is sure of, `max` reports many, some of
// them uncertain, and the higher levels spend more work getting there. A level therefore moves four
// things together, never one:
//
//   - the CONFIDENCE FLOOR: whether a finding the reviewer could not confirm is reported at all,
//     and how it is marked when it is;
//   - the FINDINGS CAP: how many findings the review may return;
//   - the VERIFY PASS: whether each candidate finding is re-checked against the code before it is
//     reported, and dropped when it does not hold;
//   - the REVIEW WIDTH: for the slicing `pr-reviewer`, each slice's turn budget and how many slice
//     reviewers run at once.
//
// A level that only moved the floor would be a reporting filter over the same review, which is not
// what the setting promises: a `max` review has to LOOK harder, not only print more.

/** What one level commits a review to. The table below is the single place the levels differ. */
interface ReviewEffortProfile {
  /** The most findings the review may return; null ⇒ no cap. */
  maxFindings: number | null
  /** Whether a finding the reviewer could not confirm is reported (marked as possible). */
  reportsUnconfirmed: boolean
  /** Whether each candidate finding is re-checked against the code before it is reported. */
  verifies: boolean
  /** The ceiling on one slice reviewer's turn budget (the floor stays 8). */
  sliceTurnCeiling: number
  /** How many slice reviewers may be in flight at once; never above the rate-limit window. */
  parallelSlices: number
}

const PROFILES: Record<ReviewEffortLevel, ReviewEffortProfile> = {
  low: {
    maxFindings: 5,
    reportsUnconfirmed: false,
    verifies: false,
    sliceTurnCeiling: 15,
    parallelSlices: 3,
  },
  medium: {
    maxFindings: 10,
    reportsUnconfirmed: false,
    verifies: false,
    sliceTurnCeiling: 25,
    parallelSlices: 4,
  },
  high: {
    maxFindings: 20,
    reportsUnconfirmed: false,
    verifies: true,
    sliceTurnCeiling: 40,
    parallelSlices: MAX_PARALLEL_SLICE_SUBAGENTS,
  },
  xhigh: {
    maxFindings: 35,
    reportsUnconfirmed: true,
    verifies: true,
    sliceTurnCeiling: 60,
    parallelSlices: MAX_PARALLEL_SLICE_SUBAGENTS,
  },
  max: {
    maxFindings: null,
    reportsUnconfirmed: true,
    verifies: true,
    sliceTurnCeiling: 80,
    parallelSlices: MAX_PARALLEL_SLICE_SUBAGENTS,
  },
}

/** The words the scale is stated in, so the prompt names the level the way the picker does. */
const LEVEL_LABEL: Record<ReviewEffortLevel, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'extra high',
  max: 'max',
}

/** The marker an unconfirmed finding's title starts with, so a reader can tell it apart. */
export const UNCONFIRMED_FINDING_MARKER = 'Possible:'

/** Which kind of review the section is written for: the two run very differently. */
export type ReviewEffortAudience = 'pr-reviewer' | 'companion'

function confidenceLines(profile: ReviewEffortProfile, item: string): string[] {
  if (!profile.reportsUnconfirmed) {
    return [
      `- Report only ${item}s you are confident are real: you can point at the code that shows the`,
      '  problem. Leave out anything you suspect but could not confirm.',
    ]
  }
  return [
    `- Report confirmed ${item}s, and also ${item}s you consider plausible but could not fully`,
    `  confirm. Start each unconfirmed one's title with "${UNCONFIRMED_FINDING_MARKER}" and say in`,
    '  its body what would confirm or rule it out.',
  ]
}

function capLine(profile: ReviewEffortProfile, item: string): string {
  return profile.maxFindings === null
    ? `- There is no cap on how many ${item}s you report. Include minor points too.`
    : `- Report at most ${profile.maxFindings} ${item}s. When you have more, keep the most severe ` +
        'and the most certain, and say in your summary how many you left out.'
}

function prReviewerLines(profile: ReviewEffortProfile): string[] {
  const lines = [
    `- Give each slice reviewer a turn budget of roughly one turn per 10 changed lines, floor 8,`,
    `  ceiling ${profile.sliceTurnCeiling}, and keep at most ${profile.parallelSlices} slice reviewers`,
    '  in flight at once. These figures replace the defaults in your instructions.',
  ]
  if (profile.verifies) {
    lines.push(
      '- Before you aggregate, VERIFY each candidate finding: dispatch a subagent (several in',
      '  parallel, within the same in-flight window) that is handed the finding and the files it',
      '  names and asked whether it holds against the code at the PR head. Drop the findings it',
      '  refutes.',
    )
    if (profile.reportsUnconfirmed) {
      lines.push(
        '  A finding the verifier could neither confirm nor refute stays in, marked as unconfirmed.',
      )
    } else {
      lines.push('  A finding the verifier could not confirm is dropped too.')
    }
  } else {
    lines.push(
      '- There is no separate verification pass at this level: the slice reviewers must hold',
      '  each finding to the confidence rule above themselves.',
    )
  }
  return lines
}

function companionLines(profile: ReviewEffortProfile): string[] {
  const lines = profile.verifies
    ? [
        '- Before you raise a point, check it: re-read the code it concerns and confirm the',
        '  problem is there. Drop the points that do not hold up.',
      ]
    : ['- Keep your review to the changed code and what it directly calls.']
  if (profile.reportsUnconfirmed) {
    lines.push('- Never raise an unconfirmed point as a `blocker`.')
  }
  return lines
}

/**
 * The section a review's prompt carries for its effort level. Placed in the USER prompt, because
 * the level is a per-task (or per-policy) fact and the system prompt is the kind's standing role,
 * which a workspace may override wholesale.
 *
 * The last line pins what the level does NOT move: severity, and for the companion its rating. A
 * low-effort review that rated the same work higher would quietly lower the bar the rework loop
 * holds it to.
 */
export function reviewEffortSection(
  level: ReviewEffortLevel,
  audience: ReviewEffortAudience,
): string {
  const profile = PROFILES[level]
  const item = audience === 'pr-reviewer' ? 'finding' : 'comment'
  return [
    '',
    `## Review effort: ${LEVEL_LABEL[level]}`,
    '',
    `This review runs at the "${LEVEL_LABEL[level]}" effort level (of low, medium, high, extra`,
    'high, max). It sets how hard you look and how much you report:',
    ...confidenceLines(profile, item),
    capLine(profile, item),
    ...(audience === 'pr-reviewer' ? prReviewerLines(profile) : companionLines(profile)),
    audience === 'pr-reviewer'
      ? '- The level never changes how you grade a finding: rate severity exactly as you would at any level.'
      : '- The level never changes how you grade: rate the work and each comment’s severity exactly as you would at any level.',
  ].join('\n')
}
