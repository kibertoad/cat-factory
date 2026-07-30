import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PipelineStep } from '~/types/execution'
import { useStepPromptVariant } from '~/composables/useStepPromptVariant'
import en from '../../i18n/locales/en.json'

/**
 * What the run panels report about a step's agent-kind VARIANT.
 *
 * The property under test is that they report what the DISPATCH did, not what the pipeline asked
 * for. A step can name a variant whose text never reached its prompt — the workspace's own edit of
 * that kind displaces a variant's replacement, and a variant can be withdrawn mid-run — and a
 * panel that echoed the selection would confirm a variation that did not run. Each losing
 * disposition therefore gets its own note.
 *
 * Assertions are on KEYS, never English text, so they stay locale-agnostic (the `t` spy echoes
 * its key) — but every key is checked against the real `en.json` so a typo can't pass.
 */

function hasKey(path: string): boolean {
  return (
    path.split('.').reduce<unknown>((node, seg) => {
      return node && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined
    }, en) !== undefined
  )
}

beforeEach(() => {
  vi.stubGlobal('useI18n', () => ({ t: (key: string) => key, te: hasKey }))
  vi.stubGlobal('useAgentsStore', () => ({
    variantLabel: (id: string) => (id === 'org:tdd' ? 'TDD-first' : id),
  }))
})

function step(promptVariant?: PipelineStep['promptVariant']): PipelineStep {
  return {
    agentKind: 'coder',
    state: 'done',
    ...(promptVariant ? { promptVariant } : {}),
  } as PipelineStep
}

describe('useStepPromptVariant', () => {
  it('reports nothing for a step that ran the shipped prompt', () => {
    expect(useStepPromptVariant(() => step()).value).toBeNull()
  })

  it('reports the label with NO note when the variant fully applied', () => {
    const variant = useStepPromptVariant(() => step({ id: 'org:tdd', applied: 'full' })).value
    expect(variant).toEqual({ label: 'TDD-first', note: null })
  })

  it('reports a note when the workspace prompt displaced the variant entirely', () => {
    // The case that used to read as a plain confirmation the variant ran.
    const variant = useStepPromptVariant(() => step({ id: 'org:tdd', applied: 'superseded' })).value
    expect(variant?.label).toBe('TDD-first')
    expect(variant?.note).toBe('panels.stepMeta.promptVariantSuperseded')
    expect(hasKey(variant!.note!)).toBe(true)
  })

  it('distinguishes a partly-applied variant from a fully displaced one', () => {
    const note = useStepPromptVariant(() => step({ id: 'org:tdd', applied: 'addition-only' })).value
      ?.note
    expect(note).toBe('panels.stepMeta.promptVariantAdditionOnly')
    expect(hasKey(note!)).toBe(true)
  })

  it('distinguishes a WITHDRAWN variant, and still names the id it asked for', () => {
    // The label falls back to the raw id: the step really was configured to run it, so rendering
    // nothing would show a varied step as if it were the stock kind.
    const variant = useStepPromptVariant(() => step({ id: 'org:gone', applied: 'withdrawn' })).value
    expect(variant?.label).toBe('org:gone')
    expect(variant?.note).toBe('panels.stepMeta.promptVariantWithdrawn')
    expect(hasKey(variant!.note!)).toBe(true)
  })
})
