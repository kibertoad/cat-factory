import type { ExecutionInstance, PipelineStep, StepContextDocument } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { composeContext, renderContext } from './prReport.context.js'

// The CONTEXT SOURCES section: what the run built FROM, reduced from the per-dispatch records its
// steps carry (Figma initiative, Track C slice 3).
//
// The whole point of the section is that a reviewer can tell an implementation that MISREAD the
// design from one that faithfully implemented a revision the designer has since moved past. The
// cases below are the ones where those two would otherwise render the same.

const NO_CAP = <T>(items: readonly T[]) => [...items]

function step(contextDocuments?: StepContextDocument[]): PipelineStep {
  return {
    agentKind: 'coder',
    state: 'done',
    progress: 1,
    ...(contextDocuments ? { contextDocuments } : {}),
  } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return { id: 'exec_1', blockId: 'blk_1', steps, currentStep: 0 } as ExecutionInstance
}

function figma(version: string): StepContextDocument {
  return {
    title: 'Checkout flow',
    url: 'https://figma.com/file/abc',
    origin: 'figma',
    freshness: { status: 'confirmed', version, change: 'unchanged' },
  }
}

describe('composeContext', () => {
  it('reports absent when no step recorded a document, saying the description was the brief', () => {
    const section = composeContext(instance([step(), step()]), NO_CAP)
    expect(section.status).toBe('absent')
    expect(section.documents).toEqual([])
    expect(section.note).toContain('No linked document')
  })

  it('reduces one document read by several dispatches to one row', () => {
    const section = composeContext(instance([step([figma('v1')]), step([figma('v1')])]), NO_CAP)
    expect(section.documents).toHaveLength(1)
    expect(section.documents[0]).toMatchObject({
      title: 'Checkout flow',
      origin: 'figma',
      freshness: { status: 'confirmed', version: 'v1' },
      movedDuringRun: false,
    })
  })

  it('keeps the LAST verdict, because that is the state the run ended on', () => {
    const section = composeContext(
      instance([
        step([figma('v1')]),
        step([
          { ...figma('v1'), freshness: { status: 'unconfirmed', reason: 'source_unreachable' } },
        ]),
      ]),
      NO_CAP,
    )
    expect(section.documents[0]?.freshness).toEqual({
      status: 'unconfirmed',
      reason: 'source_unreachable',
    })
  })

  it('flags a document whose revision MOVED between two dispatches of one run', () => {
    const section = composeContext(instance([step([figma('v1')]), step([figma('v2')])]), NO_CAP)
    // The last revision alone would read as a run that built entirely against v2; the earlier
    // step never saw it, and that is the fact a reviewer needs.
    expect(section.documents[0]).toMatchObject({
      movedDuringRun: true,
      freshness: { version: 'v2' },
    })
  })

  it('keeps a document with NO verdict apart from one that was checked and could not be confirmed', () => {
    const unchecked: StepContextDocument = {
      title: 'PRD',
      url: 'https://notion.so/prd',
      origin: 'notion',
    }
    const section = composeContext(instance([step([unchecked, figma('v1')])]), NO_CAP)
    // Absent `freshness` means nobody asked (no refresher wired); `unconfirmed` means asked and
    // could not tell. Only the second is a warning about the copy the agent read.
    expect(section.documents[0]?.freshness).toBeUndefined()
    expect(section.documents[1]?.freshness).toMatchObject({ status: 'confirmed' })
  })

  it('separates two documents that differ only by source, since the ids live in different key spaces', () => {
    const section = composeContext(
      instance([step([figma('v1'), { ...figma('v1'), origin: 'zeplin' }])]),
      NO_CAP,
    )
    expect(section.documents).toHaveLength(2)
  })
})

describe('renderContext', () => {
  it('renders an absent section as a note rather than omitting it', () => {
    const rendered = renderContext(composeContext(instance([step()]), NO_CAP)).join('\n')
    expect(rendered).toContain('### Context sources')
    expect(rendered).toContain('No linked document')
  })

  it('names the revision each document was read at', () => {
    const rendered = renderContext(composeContext(instance([step([figma('v7')])]), NO_CAP)).join(
      '\n',
    )
    expect(rendered).toContain('`v7`')
    expect(rendered).toContain('[Checkout flow](https://figma.com/file/abc)')
  })

  it('leads with a call-out when a document moved mid-run', () => {
    const rendered = renderContext(
      composeContext(instance([step([figma('v1')]), step([figma('v2')])]), NO_CAP),
    ).join('\n')
    expect(rendered).toContain('changed while this run was in flight')
  })

  it('states each non-confirmed verdict distinctly, never as a bare dash', () => {
    const rendered = renderContext(
      composeContext(
        instance([
          step([
            {
              title: 'Uploaded brief',
              url: '',
              origin: 'upload',
              freshness: { status: 'not-applicable' },
            },
            { title: 'Never asked', url: 'https://notion.so/x', origin: 'notion' },
            {
              title: 'Refused',
              url: 'https://figma.com/file/z',
              origin: 'figma',
              freshness: { status: 'unconfirmed', reason: 'not_connected' },
            },
          ]),
        ]),
        NO_CAP,
      ),
    ).join('\n')
    expect(rendered).toContain('no source to compare against')
    expect(rendered).toContain('not checked')
    expect(rendered).toContain('no longer connected to the source')
  })

  it('neutralises a document title that would otherwise break the table row', () => {
    const rendered = renderContext(
      composeContext(
        instance([step([{ ...figma('v1'), title: 'Fixes #12\n| injected |' }])]),
        NO_CAP,
      ),
    ).join('\n')
    // One row: a raw newline would end the table, and `#12` would auto-link into the host's
    // issue tracker (and a closing keyword before it would CLOSE that issue on merge).
    expect(rendered).not.toContain('Fixes #12\n')
    expect(rendered).not.toContain('#12')
  })
})
