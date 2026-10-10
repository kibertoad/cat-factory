import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { hostMarkdown } from '@cat-factory/kernel'
import { parsePrVerificationReport } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { composePrVerificationReport, renderPrVerificationReport } from './prReport.logic.js'

// The Coder-follow-ups section: what the build flagged mid-run and what was decided about each
// item. A sibling file rather than more cases in `prReport.logic.test.ts`, on the same split as
// `prReport.environments.test.ts` and for the same reason: every case here is about the section
// refusing to overstate what it knows, which is a different subject from "the report names every
// section it did not produce".
//
// Driven through the whole report because `composeFollowUps` / `renderFollowUps` are private to
// the module, and the render is half of what is asserted.

const BLOCK = { id: 'blk_1', title: 'Add login', level: 'task' } as unknown as Block

function step(partial: Partial<PipelineStep> & { agentKind: string }): PipelineStep {
  return { state: 'done', progress: 1, decision: null, ...partial } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_simple',
    pipelineName: 'Quick implement',
    steps,
    currentStep: steps.length - 1,
    status: 'done',
  } as ExecutionInstance
}

const INPUTS = {
  block: BLOCK,
  issues: [],
  runUrl: null,
  trajectoryUrl: null,
  reportUrl: null,
  environments: { provisioning: { status: 'unwired' as const }, evidenceUrl: null },
  now: 1_700_000_000_000,
}

/** One surfaced item, carrying only the fields the section reduces. */
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'follow_up',
  title: `Loose end ${id}`,
  detail: '',
  status: 'queued',
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

/** A follow-up-enabled Coder step, with the budget it spent and what it surfaced. */
const coder = (over: Record<string, unknown> = {}) =>
  step({
    agentKind: 'coder',
    followUps: { enabled: true, items: [], loops: 0, maxLoops: 3, ...over },
  })

const compose = (steps: PipelineStep[]) => composePrVerificationReport(instance(steps), INPUTS)

describe('composePrVerificationReport: Coder follow-ups', () => {
  it('tells a companion that surfaced nothing from one that was never enabled', () => {
    // Two different facts about the build, and a single `absent` note for both would be the
    // "absent and zero must not render the same" failure one level down.
    const report = compose([coder()])
    expect(report.followUps.status).toBe('absent')
    expect(report.followUps.note).toContain('surfaced no loose ends')
  })

  it('reports a send-back the loop budget dropped, and says so above the table', () => {
    const report = compose([
      coder({
        loops: 3,
        items: [
          item('fu_1', {
            kind: 'question',
            title: 'Which IngressClass is default?',
            status: 'closed',
            answer: 'Nobody here knows.',
          }),
          item('fu_2', { title: 'Dedupe the retry helper', sendBackDropped: true }),
        ],
      }),
    ])

    expect(report.followUps.status).toBe('reported')
    expect(report.followUps.dropped).toBe(1)
    expect(report.followUps.total).toBe(2)
    expect(report.followUps.entries.map((e) => e.status)).toEqual(['closed', 'queued'])
    // Quoted by the banner in place of the section-level pair, which sums EVERY enabled step.
    expect(report.followUps.droppedBudget).toEqual({ loops: 3, maxLoops: 3 })

    const body = renderPrVerificationReport(report)
    expect(body).toContain('### Coder follow-ups')
    // The count leads, because a reader who has to derive it from a status column will not.
    expect(body).toContain('1 decided follow-up never reached the Coder')
    expect(body).toContain('(3/3 passes)')
    expect(body).toContain('They are marked below.')
    expect(body).toContain('never sent')
    expect(body).toContain('ruled on, no further pass')
    expect(() => parsePrVerificationReport(report)).not.toThrow()
  })

  it('quotes only the exhausted step’s budget, so a spent one never reads as half-spent', () => {
    // Two follow-up-enabled Coders: the first exhausts at 3/3 and drops a decision, the second
    // never loops. Summed across both the section reads 3/6, and a banner asserting a SPENT budget
    // over 3-of-6 tells the reviewer the platform discarded their decision for no reason.
    const report = compose([
      coder({ loops: 3, items: [item('fu_1', { sendBackDropped: true })] }),
      coder({ items: [item('fu_2', { status: 'filed' })] }),
    ])

    // The section-level pair still sums every enabled step: that is what it is for.
    expect(report.followUps.loops).toBe(3)
    expect(report.followUps.maxLoops).toBe(6)
    // The banner's pair does not, and over the exhausted steps alone the two are equal.
    expect(report.followUps.droppedBudget).toEqual({ loops: 3, maxLoops: 3 })
    expect(renderPrVerificationReport(report)).toContain('(3/3 passes)')
  })

  it('counts policy dismissals over every item, not over the ones the cap left visible', () => {
    // `dismissedByPolicy` used to be recounted off the capped entries at render time, so a run
    // whose dismissals all fell past the cap printed "0 items" and suppressed the line entirely
    // while having dismissed every one of them unattended.
    const report = compose([
      coder({
        items: Array.from({ length: 3 }, (_, i) =>
          item(`fu_${i}`, { status: 'dismissed', dismissedByPolicy: true }),
        ),
      }),
    ])

    expect(report.followUps.dismissedByPolicy).toBe(3)
    expect(report.followUps.dropped).toBe(0)
    expect(report.followUps.droppedBudget).toBeNull()
    const body = renderPrVerificationReport(report)
    expect(body).toContain('3 items were dismissed by the run')
    expect(body).not.toContain('never reached the Coder')
  })

  it('stops promising the dropped items are marked below once the cap has removed them', () => {
    // The counts are whole-run and the table is a capped PREFIX, so the two disagree as soon as a
    // triage-heavy run overflows. "They are marked below" then sends a reviewer looking for rows
    // that are not there, and they conclude the banner is the bug.
    const dropped = hostMarkdown.MAX_LIST_ITEMS + 5
    const report = compose([
      coder({
        loops: 3,
        items: Array.from({ length: dropped }, (_, i) =>
          item(`fu_${i}`, { sendBackDropped: true }),
        ),
      }),
    ])

    expect(report.followUps.total).toBe(dropped)
    expect(report.followUps.dropped).toBe(dropped)
    expect(report.followUps.entries).toHaveLength(hostMarkdown.MAX_LIST_ITEMS)

    const body = renderPrVerificationReport(report)
    expect(body).toContain(`${dropped} decided follow-ups never reached the Coder`)
    expect(body).toContain(`shows the first ${hostMarkdown.MAX_LIST_ITEMS} of ${dropped} items`)
    expect(body).not.toContain('They are marked below.')
  })
})
