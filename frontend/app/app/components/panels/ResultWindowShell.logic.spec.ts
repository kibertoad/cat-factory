import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROSE_MEASURE_CLASS, type ResultWindowWidth } from './ResultWindowShell.logic'

// The width decision is a per-window LAYOUT judgement that lives on each window's
// `<ResultWindowShell width="…">`, which means nothing in the type system can ask a window author
// to justify it — and the `full` bucket carries an obligation (continuous prose takes its own
// reading measure) the shell explicitly cannot enforce on its slot content. That combination is
// what this file pins, the way `nav-contributions.spec.ts` pins the advanced-nav set: a table
// naming every window's bucket AND the reason, asserted against what the components actually pass.
//
// It caught its own motivating bug — the tracker, spec and tester windows moved to `full` with no
// measure anywhere in them, so their agent-written summaries ran the width of the display.

/** The default the shell applies when a window passes no `width` (`withDefaults`). */
const SHELL_DEFAULT_WIDTH: ResultWindowWidth = '3xl'

/**
 * Every `ResultWindowShell` consumer, its bucket, and why that bucket. The reason is the point:
 * `full` is for a body that lays out in COLUMNS, where the width buys visible layout, and a
 * one-column verdict or reader keeps a bucket. A row that cannot state which of those it is has
 * not made the decision.
 */
const WINDOWS: Record<string, { width: ResultWindowWidth; why: string }> = {
  'binaryCandidates/BinaryCandidatesWindow.vue': {
    width: '5xl',
    why: 'a preview grid of generated candidates grouped by subject, read side by side to be compared, with no rail beside it',
  },
  'brainstorm/BrainstormWindow.vue': {
    width: 'full',
    why: 'options column + the choose/dismiss action rail',
  },
  'bugFishing/BugFishingWindow.vue': {
    width: 'full',
    why: 'the angle rail + the catch column, whose finding rows lay badges, path and the mark/dismiss actions out beside each other',
  },
  'clarity/ClarityReviewWindow.vue': {
    width: 'full',
    why: 'findings column + the answer/dismiss action rail',
  },
  'consensus/ConsensusSessionWindow.vue': {
    width: '5xl',
    why: 'one stacked column of participant prose — no rail competing with it, so width would only lengthen lines',
  },
  'docs/DocInterviewWindow.vue': { width: '3xl', why: 'one column of interview question + answer' },
  'followUp/FollowUpWindow.vue': { width: '3xl', why: 'a short list of follow-up items' },
  'forkDecision/ForkDecisionWindow.vue': {
    width: '3xl',
    why: 'two proposals and a choice between them',
  },
  'gates/GateResultView.vue': { width: '3xl', why: 'a gate verdict — one column, short' },
  'humanTest/HumanTestWindow.vue': {
    width: '3xl',
    why: 'one instruction plus a pass/fail control',
  },
  'initiative/InitiativePlanningWindow.vue': {
    width: '4xl',
    why: 'a planning-progress readout, one column',
  },
  'initiative/InitiativeTrackerWindow.vue': {
    width: 'full',
    why: 'tracker column + run-metadata rail, and it hands its whole body to the three-column plan review while a plan is parked',
  },
  'judge/JudgeResultView.vue': { width: '3xl', why: 'a rubric verdict — one column, short' },
  'outcome/OutcomeSummaryWindow.vue': {
    width: '3xl',
    why: 'the run outcome summary: one column of short evidence sections, no rail to lay out beside it',
  },
  'panels/GenericStructuredResultView.vue': {
    width: '4xl',
    why: 'the fallback structured-result reader, one column of sections',
  },
  'panels/MergerResultView.vue': {
    width: '3xl',
    why: 'the merge verdict and its scores — one column, short (the slice-5 pilot)',
  },
  'prReview/PrReviewWindow.vue': {
    width: 'full',
    why: 'per-file findings with paths, line numbers and suggested fixes, + a rail',
  },
  'ralph/RalphLoopResultView.vue': { width: '3xl', why: 'a loop status readout, one column' },
  'requirements/RequirementsReviewWindow.vue': {
    width: 'full',
    why: 'findings column + the answer/dismiss action rail',
  },
  'spec/ServiceSpecWindow.vue': {
    width: 'full',
    why: 'module/feature-group nav column + the spec detail column',
  },
  'testing/TestReportWindow.vue': {
    width: 'full',
    why: 'scenario/outcome/concern tree + run-metadata rail',
  },
  'visualConfirm/VisualConfirmationWindow.vue': {
    width: '5xl',
    why: 'a screenshot grid whose full-bleed reading is the nested ArtifactLightbox, not this window',
  },
}

// Anchored on the vitest root (`frontend/app`) rather than `import.meta.url`: the `happy-dom`
// environment replaces the global `URL`, and `fileURLToPath` then rejects its own file: URLs.
const componentsDir = resolve(process.cwd(), 'app/components')

/** Every component that mounts the shell, keyed by its path relative to `app/components`. */
function findConsumers(): Map<string, string> {
  const found = new Map<string, string>()
  for (const entry of readdirSync(componentsDir, { recursive: true, encoding: 'utf8' })) {
    const rel = entry.replace(/\\/g, '/')
    // The shell itself names its own tag in its header comment — it is not a consumer.
    if (!rel.endsWith('.vue') || rel.endsWith('panels/ResultWindowShell.vue')) continue
    const source = readFileSync(`${componentsDir}/${rel}`, 'utf8')
    if (source.includes('<ResultWindowShell')) found.set(rel, source)
  }
  return found
}

/** The bucket a component passes, or the shell's default when it passes none. */
function declaredWidth(source: string): ResultWindowWidth {
  const match = /<ResultWindowShell[\s\S]*?\swidth="([^"]+)"/.exec(source)
  return (match?.[1] as ResultWindowWidth | undefined) ?? SHELL_DEFAULT_WIDTH
}

describe('result-window width buckets', () => {
  const consumers = findConsumers()

  it('finds the shell consumers at all (the scan is doing real work)', () => {
    expect(existsSync(componentsDir), `no components dir at ${componentsDir}`).toBe(true)
    expect(consumers.size).toBeGreaterThan(10)
  })

  it('covers every consumer, with no stale rows', () => {
    expect([...consumers.keys()].sort()).toEqual(Object.keys(WINDOWS).sort())
  })

  it('matches what each window actually passes', () => {
    const actual = [...consumers.entries()].map(([file, source]) => [file, declaredWidth(source)])
    const declared = Object.entries(WINDOWS).map(([file, row]) => [file, row.width])
    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(declared))
  })

  it('makes every window state a reason for its bucket', () => {
    for (const [file, row] of Object.entries(WINDOWS)) {
      expect(row.why.length, `${file} must say why it takes \`${row.width}\``).toBeGreaterThan(20)
    }
  })

  // The obligation the shell cannot enforce on its own slot content: a `full` window's continuous
  // prose carries the step reader's measure, or the extra width lands as 200-character lines. A
  // window with none anywhere is the shape this catches — it either has no prose (say so by
  // pointing at the measure it does not need) or it forgot.
  it('holds every `full` window to the prose reading measure', () => {
    for (const [file, row] of Object.entries(WINDOWS)) {
      if (row.width !== 'full') continue
      const source = consumers.get(file)
      expect(
        source?.includes(PROSE_MEASURE_CLASS),
        `${file} is \`full\`, so its continuous prose must carry \`${PROSE_MEASURE_CLASS}\``,
      ).toBe(true)
    }
  })
})

describe('PROSE_MEASURE_CLASS', () => {
  it('is the measure the step reader already uses', () => {
    // `AgentStepDetail` reads prose at its own measure; the windows must not hold a second
    // opinion about how wide prose should be, so the constant is checked against that source.
    const stepReader = readFileSync(resolve(componentsDir, 'panels/AgentStepDetail.vue'), 'utf8')
    expect(stepReader).toContain(PROSE_MEASURE_CLASS)
  })
})
