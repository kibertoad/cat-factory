import { describe, expect, it } from 'vitest'
import { systemPromptFor } from '../catalog.js'
import { shippedBasePromptFor } from '../prompts/bespoke-kinds.js'
import { AgentKindRegistry, defaultAgentKindRegistry } from './registry.js'
import { applyAgentVariant } from './variants.js'
import { READ_ONLY_GUARDRAIL } from './read-only.js'
import { FINAL_ANSWER_IN_REPLY } from '../prompts/shared.js'

// Agent-kind VARIANTS: an alternate prompt for an EXISTING kind, selected per step.
//
// Three properties carry the whole feature and none of them is visible from a call site:
// an unvaried dispatch must be byte-for-byte what it always sent; a variant must not be able to
// delete a platform invariant (it rides the same seam a workspace override does, so it inherits
// that guarantee — these pin that it really does); and an ADDITION must fold onto whatever base
// actually runs, including a workspace's own override, rather than onto the shipped text.

const registry = defaultAgentKindRegistry()

describe('applyAgentVariant', () => {
  it('overrides nothing when there is no variant and no workspace override', () => {
    expect(applyAgentVariant('shipped', undefined, undefined)).toBeUndefined()
  })

  it('passes a workspace override through untouched when there is no variant', () => {
    expect(applyAgentVariant('shipped', undefined, 'mine')).toBe('mine')
  })

  it('replaces the shipped prompt with a variant systemPrompt', () => {
    const variant = { id: 'v', baseKind: 'coder', systemPrompt: 'Be a poet.' }
    expect(applyAgentVariant('shipped', variant)).toBe('Be a poet.')
  })

  it('lets the WORKSPACE override win over a variant replacement — the narrower tier', () => {
    const variant = { id: 'v', baseKind: 'coder', systemPrompt: 'Be a poet.' }
    expect(applyAgentVariant('shipped', variant, 'mine')).toBe('mine')
  })

  it('folds an addition onto the shipped prompt when nothing replaced it', () => {
    const variant = { id: 'v', baseKind: 'coder', promptAddition: 'Work test-first.' }
    expect(applyAgentVariant('shipped', variant)).toBe('shipped\n\nWork test-first.')
  })

  it('folds an addition onto the WORKSPACE override, not the shipped prompt', () => {
    // The reason `promptAddition` is the safe default: it keeps applying on top of whatever base
    // the deployment and the workspace have arrived at, instead of forking a copy of the text.
    const variant = { id: 'v', baseKind: 'coder', promptAddition: 'Work test-first.' }
    expect(applyAgentVariant('shipped', variant, 'mine')).toBe('mine\n\nWork test-first.')
  })

  it('folds an addition onto the variant own replacement when both are declared', () => {
    const variant = {
      id: 'v',
      baseKind: 'coder',
      systemPrompt: 'Be a poet.',
      promptAddition: 'In haiku.',
    }
    expect(applyAgentVariant('shipped', variant)).toBe('Be a poet.\n\nIn haiku.')
  })

  it('ignores a whitespace-only addition rather than appending a blank tail', () => {
    const variant = { id: 'v', baseKind: 'coder', promptAddition: '   ' }
    expect(applyAgentVariant('shipped', variant)).toBeUndefined()
  })
})

describe('a variant composed the way a dispatch composes it', () => {
  /** What the engine hands the executor, then what the executor composes from it. */
  function composed(kind: string, variant: Parameters<typeof applyAgentVariant>[1]): string {
    const override = applyAgentVariant(shippedBasePromptFor(kind, registry), variant)
    return systemPromptFor(kind, registry, override)
  }

  it('keeps the read-only guardrail when a variant REPLACES a read-only kind prompt', () => {
    const composedPrompt = composed('architect', {
      id: 'v',
      baseKind: 'architect',
      systemPrompt: 'Just say what you would do.',
    })
    expect(composedPrompt).toContain('Just say what you would do.')
    expect(composedPrompt).toContain(READ_ONLY_GUARDRAIL)
    expect(composedPrompt).toContain(FINAL_ANSWER_IN_REPLY)
  })

  it('keeps the shipped prompt intact under an ADDITION', () => {
    const composedPrompt = composed('coder', {
      id: 'v',
      baseKind: 'coder',
      promptAddition: 'Work test-first.',
    })
    expect(composedPrompt).toContain(shippedBasePromptFor('coder', registry))
    expect(composedPrompt).toContain('Work test-first.')
  })

  it('varies a BESPOKE-prompt kind against its role half, keeping its output contract', () => {
    // `merger` never reaches `systemPromptFor`: its shipped base is the ROLE half, and its
    // directives (the JSON contract the engine parses) are re-appended by the dispatch site. If
    // `shippedBasePromptFor` returned the wrong text here, an addition would fold onto a prompt
    // the kind does not run and a replacement would be measured against nothing.
    const role = shippedBasePromptFor('merger', registry)
    expect(role).toContain('release manager')
    expect(role).not.toContain(FINAL_ANSWER_IN_REPLY)
    const override = applyAgentVariant(role, {
      id: 'v',
      baseKind: 'merger',
      promptAddition: 'Weigh migrations as high risk.',
    })
    expect(override).toBe(`${role}\n\nWeigh migrations as high risk.`)
  })
})

describe('AgentKindRegistry variants', () => {
  it('registers, reads back, and groups variants by base kind', () => {
    const reg = new AgentKindRegistry()
    reg.registerVariants([
      { id: 'a', baseKind: 'coder', promptAddition: 'x' },
      { id: 'b', baseKind: 'coder', promptAddition: 'y' },
      { id: 'c', baseKind: 'architect', promptAddition: 'z' },
    ])
    expect(reg.variant('a')?.baseKind).toBe('coder')
    expect(reg.variant('nope')).toBeUndefined()
    expect(reg.variants()).toHaveLength(3)
    expect(reg.variantsForKind('coder').map((v) => v.id)).toEqual(['a', 'b'])
    expect(reg.variantsForKind('merger')).toEqual([])
  })

  it('lets a later registration REPOINT a variant an installed package shipped', () => {
    const reg = new AgentKindRegistry()
    reg.registerVariant({ id: 'a', baseKind: 'coder', promptAddition: 'vendor text' })
    reg.registerVariant({ id: 'a', baseKind: 'coder', promptAddition: 'our text' })
    expect(reg.variants()).toHaveLength(1)
    expect(reg.variant('a')?.promptAddition).toBe('our text')
  })

  it('never lets a variant masquerade as an agent kind', () => {
    // The property the whole design rests on: a variant is a per-step OPTION, so nothing that
    // resolves a KIND — the palette projection, the executor routing, the prompt lookup — can
    // ever see one.
    const reg = new AgentKindRegistry()
    reg.registerVariant({ id: 'org:coder-tdd', baseKind: 'coder', promptAddition: 'x' })
    expect(reg.get('org:coder-tdd')).toBeUndefined()
    expect(reg.all()).toEqual([])
    expect(reg.systemPrompt('org:coder-tdd')).toBeUndefined()
    expect(reg.requiresContainer('org:coder-tdd')).toBe(false)
  })
})
