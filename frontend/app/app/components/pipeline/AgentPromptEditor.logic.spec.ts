import { describe, expect, it } from 'vitest'
import type { AgentPromptDetail, AgentPromptRevision } from '~/types/agent-prompts'
import {
  draftForRevision,
  isDirty,
  isRevisionConflict,
  saveIntent,
} from './AgentPromptEditor.logic'

const BUILTIN = 'You are a careful engineer.'

function rev(overrides: Partial<AgentPromptRevision> = {}): AgentPromptRevision {
  return { agentKind: 'coder', revision: 1, text: 'v1 text', createdAt: 1, ...overrides }
}

function detail(overrides: Partial<AgentPromptDetail> = {}): AgentPromptDetail {
  return {
    agentKind: 'coder',
    builtinText: BUILTIN,
    appendedText: '',
    effectiveText: BUILTIN,
    customized: false,
    revisions: [],
    ...overrides,
  }
}

describe('saveIntent', () => {
  it('sends the typed text as an override', () => {
    expect(saveIntent('Be terse.', detail(), undefined)).toEqual({ text: 'Be terse.' })
  })

  it('sends null when the draft is the built-in, so the workspace keeps tracking it', () => {
    // Storing a copy of the built-in would pin the workspace to today's wording — the exact
    // thing the null revision exists to avoid.
    expect(saveIntent(`  ${BUILTIN}  `, detail(), undefined)).toEqual({ text: null })
  })

  it('keeps restoredFrom while the draft still is that revision', () => {
    const d = detail({ revisions: [rev({ revision: 3, text: 'v3 text' })] })
    expect(saveIntent('v3 text', d, 3)).toEqual({ text: 'v3 text', restoredFrom: 3 })
  })

  it('DROPS restoredFrom once the draft has been edited away from that revision', () => {
    // The regression this exists for: restore v3, tweak a line, save — and the log claims the
    // new entry is v3 restored, so anyone tracing "what were we running" is misled by a record
    // that reads as authoritative. Nothing errors; it is only wrong.
    const d = detail({ revisions: [rev({ revision: 3, text: 'v3 text' })] })
    expect(saveIntent('v3 text plus my edit', d, 3)).toEqual({ text: 'v3 text plus my edit' })
  })

  it('drops a restoredFrom naming a revision the (reloaded) log no longer has', () => {
    // After a 409 the store holds the SERVER's log. A stale pick from before that reload must
    // not be sent — the server would refuse it as `unknown_revision` and lose the user's text.
    expect(saveIntent('anything', detail({ revisions: [rev({ revision: 1 })] }), 9)).toEqual({
      text: 'anything',
    })
  })

  it('keeps restoredFrom when restoring a revert revision, and still sends null', () => {
    const d = detail({ revisions: [rev({ revision: 2, text: null })] })
    expect(saveIntent(BUILTIN, d, 2)).toEqual({ text: null, restoredFrom: 2 })
  })
})

describe('isDirty', () => {
  it('ignores whitespace-only differences, which the payload would trim away anyway', () => {
    expect(isDirty(`  ${BUILTIN}\n`, detail())).toBe(false)
    expect(isDirty(`${BUILTIN} and more`, detail())).toBe(true)
  })
})

describe('draftForRevision', () => {
  it('loads a revert revision as the built-in text', () => {
    expect(draftForRevision(rev({ text: null }), detail())).toBe(BUILTIN)
  })

  it('loads an edited revision as its own text', () => {
    expect(draftForRevision(rev({ text: 'mine' }), detail())).toBe('mine')
  })
})

describe('isRevisionConflict', () => {
  it('recognises the append-only log’s refusal, and nothing else', () => {
    expect(
      isRevisionConflict({ data: { error: { details: { reason: 'prompt_revision_conflict' } } } }),
    ).toBe(true)
    expect(
      isRevisionConflict({ data: { error: { details: { reason: 'unknown_revision' } } } }),
    ).toBe(false)
    expect(isRevisionConflict(new Error('offline'))).toBe(false)
  })
})
