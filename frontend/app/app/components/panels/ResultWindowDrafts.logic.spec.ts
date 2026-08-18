import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// UX-79: a result window that holds typed-but-unsubmitted input must not discard it when the user
// dismisses the window. `ResultWindowShell` closes on the X, on Escape and on a backdrop click, and
// a window wired `@close="close"` goes straight through all three — so a reviewer who tabbed away
// mid-sentence lost the sentence, with nothing on screen having said so.
//
// The seams to fix it already existed and were used by exactly two of the thirteen windows that
// needed them. That is the shape this file guards against: not a missing primitive, but a primitive the
// next window silently doesn't reach for (the re-audit's cross-cutting theme 8). Nothing in the type
// system can ask "does this window hold a draft?", so the table below is the answer, asserted
// against what the components actually do.
//
// The two sanctioned dispositions, and the rule for picking:
//
//   'flush'   — `useResultView({ onClose })`. For a draft whose save is a PLAIN SAVE: recording it
//               changes nothing else, so writing it on the way out is what the user meant. The
//               review windows and the doc interview persist one answer at a time.
//   'confirm' — `useUnsavedGuard` in front of the shell's close. For a draft whose only submit
//               button also DECIDES something — resolves a gate, spends a bounded chat turn, keeps
//               an artifact, re-runs an agent. A stray Escape may not do that on the user's behalf,
//               so the only honest options are to keep the draft or to ask.
//
// A window with no draft state is 'none' and closes straight through, as it always did.

/** Anchored on the vitest root (`frontend/app`) — see the sibling width spec for why not `import.meta.url`. */
const componentsDir = resolve(process.cwd(), 'app/components')

type Disposition = 'none' | 'flush' | 'confirm'

/**
 * Every `ResultWindowShell` consumer and how it treats unsubmitted input. The `why` is the point for
 * anything other than 'none': it has to name the draft, because "this window has no draft" is the
 * claim that gets silently falsified when someone adds a textarea to it.
 */
const WINDOWS: Record<string, { drafts: Disposition; why: string }> = {
  'binaryCandidates/BinaryCandidatesWindow.vue': {
    drafts: 'confirm',
    why: 'the keep rationale + per-candidate store-as aliases; Keep commits the artifacts',
  },
  'brainstorm/BrainstormWindow.vue': {
    drafts: 'confirm',
    why: 'per-item replies + the redo comment; a reply resolves an item and the redo starts a pass',
  },
  'clarity/ClarityReviewWindow.vue': {
    drafts: 'flush',
    why: 'per-finding answers, each recorded on its own',
  },
  'consensus/ConsensusSessionWindow.vue': { drafts: 'none', why: 'a read-only transcript' },
  'docs/DocInterviewWindow.vue': {
    drafts: 'flush',
    why: 'per-question answers, each recorded on its own (Submit is a separate command)',
  },
  'followUp/FollowUpWindow.vue': {
    drafts: 'confirm',
    why: 'per-question answers; sending one decides the item and re-arms the run',
  },
  'forkDecision/ForkDecisionWindow.vue': {
    drafts: 'confirm',
    why: 'the custom approach, the steering note and the chat box; chat spends a bounded turn budget',
  },
  'gates/GateResultView.vue': {
    drafts: 'confirm',
    why: 'the human-review fix instructions; Request fix resolves the gate and dispatches a fixer',
  },
  'humanTest/HumanTestWindow.vue': {
    drafts: 'confirm',
    why: 'the tester findings, the only record of what went wrong; Request fix resolves the gate',
  },
  'initiative/InitiativePlanningWindow.vue': {
    drafts: 'none',
    why: 'a planning-progress readout',
  },
  'initiative/InitiativeTrackerWindow.vue': {
    drafts: 'confirm',
    why: 'it hands its body to the plan review, whose anchored comments + feedback send back a re-plan',
  },
  'judge/JudgeResultView.vue': {
    drafts: 'confirm',
    why: 'the guidance box; every command carrying it also resolves the parked verdict',
  },
  'outcome/OutcomeSummaryWindow.vue': { drafts: 'none', why: 'a read-only run summary' },
  'panels/GenericStructuredResultView.vue': {
    drafts: 'none',
    why: 'a read-only structured reader',
  },
  'panels/MergerResultView.vue': { drafts: 'none', why: 'a read-only merge verdict' },
  'prReview/PrReviewWindow.vue': {
    drafts: 'confirm',
    why: 'the per-finding challenge box; sending it spends a reviewer turn',
  },
  'ralph/RalphLoopResultView.vue': { drafts: 'none', why: 'a loop status readout' },
  'requirements/RequirementsReviewWindow.vue': {
    drafts: 'flush',
    why: 'per-finding answers, each recorded on its own',
  },
  'spec/ServiceSpecWindow.vue': { drafts: 'none', why: 'a read-only spec reader' },
  'testing/TestReportWindow.vue': { drafts: 'none', why: 'a read-only test report' },
  'visualConfirm/VisualConfirmationWindow.vue': {
    drafts: 'confirm',
    why: 'per-view notes anchored to a screenshot + the overall findings box; Request fix resolves the gate',
  },
}

/** Every component that mounts the shell, keyed by its path relative to `app/components`. */
function findConsumers(): Map<string, string> {
  const found = new Map<string, string>()
  for (const entry of readdirSync(componentsDir, { recursive: true, encoding: 'utf8' })) {
    const rel = entry.replace(/\\/g, '/')
    if (!rel.endsWith('.vue') || rel.endsWith('panels/ResultWindowShell.vue')) continue
    const source = readFileSync(`${componentsDir}/${rel}`, 'utf8')
    if (source.includes('<ResultWindowShell')) found.set(rel, source)
  }
  return found
}

/** What the component's `<ResultWindowShell>` binds its close to. */
function closeBinding(source: string): string | null {
  return /<ResultWindowShell[\s\S]*?@close="([^"]+)"/.exec(source)?.[1] ?? null
}

/** Whether the window registers the flush hook on its `useResultView` seam. */
function registersFlushHook(source: string): boolean {
  return /useResultView\([\s\S]*?onClose:/.test(source)
}

describe('result-window draft handling', () => {
  const consumers = findConsumers()

  it('covers every shell consumer, with no stale rows', () => {
    expect(consumers.size).toBeGreaterThan(10)
    expect([...consumers.keys()].sort()).toEqual(Object.keys(WINDOWS).sort())
  })

  // The defect UX-79 named: a window holding a draft whose close goes straight to `ui.closeResultView`.
  it('routes every draft-holding window through a flush or a confirm', () => {
    const offenders = [...consumers.entries()].filter(([file, source]) => {
      const row = WINDOWS[file]!
      if (row.drafts === 'none') return false
      if (row.drafts === 'flush') return !registersFlushHook(source)
      // 'confirm': the shell's close must reach the guard, not `useResultView`'s raw `close`.
      return closeBinding(source) === 'close'
    })
    expect(offenders.map(([file]) => file)).toEqual([])
  })

  // The inverse, and the one that actually rots: a window declared draft-free that grew a textarea.
  // Without this the table degrades into a list of what someone once believed.
  it('finds no unsubmitted input in a window declared draft-free', () => {
    const suspects = [...consumers.entries()]
      .filter(([file]) => WINDOWS[file]!.drafts === 'none')
      .filter(([, source]) => /<(textarea|UTextarea)\b|v-model="drafts/.test(source))
    expect(suspects.map(([file]) => file)).toEqual([])
  })

  // A row that says 'confirm'/'flush' but names no draft is a row nobody thought about.
  it('makes every non-trivial row say what the draft is', () => {
    for (const [file, row] of Object.entries(WINDOWS)) {
      if (row.drafts !== 'none') expect(row.why.length, file).toBeGreaterThan(20)
    }
  })
})
