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
    expect(applyAgentVariant('shipped', undefined, undefined).prompt).toBeUndefined()
  })

  it('passes a workspace override through untouched when there is no variant', () => {
    expect(applyAgentVariant('shipped', undefined, 'mine').prompt).toBe('mine')
  })

  it('replaces the shipped prompt with a variant systemPrompt', () => {
    const variant = { id: 'v', baseKind: 'coder', systemPrompt: 'Be a poet.' }
    expect(applyAgentVariant('shipped', variant)).toMatchObject({
      prompt: 'Be a poet.',
      applied: 'full',
    })
  })

  it('folds an addition onto the shipped prompt when nothing replaced it', () => {
    const variant = { id: 'v', baseKind: 'coder', promptAddition: 'Work test-first.' }
    expect(applyAgentVariant('shipped', variant)).toMatchObject({
      prompt: 'shipped\n\nWork test-first.',
      applied: 'full',
    })
  })

  it('folds an addition onto the WORKSPACE override, not the shipped prompt', () => {
    // The reason `promptAddition` is the safe default: it keeps applying on top of whatever base
    // the deployment and the workspace have arrived at, instead of forking a copy of the text.
    const variant = { id: 'v', baseKind: 'coder', promptAddition: 'Work test-first.' }
    expect(applyAgentVariant('shipped', variant, 'mine')).toMatchObject({
      prompt: 'mine\n\nWork test-first.',
      applied: 'full',
    })
  })

  it('folds an addition onto the variant own replacement when both are declared', () => {
    const variant = {
      id: 'v',
      baseKind: 'coder',
      systemPrompt: 'Be a poet.',
      promptAddition: 'In haiku.',
    }
    expect(applyAgentVariant('shipped', variant)).toMatchObject({
      prompt: 'Be a poet.\n\nIn haiku.',
      applied: 'full',
    })
  })

  it('ignores a whitespace-only addition rather than appending a blank tail', () => {
    const variant = { id: 'v', baseKind: 'coder', promptAddition: '   ' }
    expect(applyAgentVariant('shipped', variant).prompt).toBeUndefined()
  })
})

// What the variant CONTRIBUTED is a separate fact from what was selected, and every caller that
// reports or keys on a varied step reads it rather than the selection: the workspace out-ranks a
// deployment on the same unit of text, so a selected variant routinely reaches the prompt only
// partly, or not at all.
describe('applyAgentVariant — what the variant actually contributed', () => {
  const replacing = { id: 'v', baseKind: 'coder', systemPrompt: 'Be a poet.' }

  it('reports a replacement DISPLACED by the workspace as superseded, contributing nothing', () => {
    // The workspace still wins — that is the intended precedence — but the variant's text is gone
    // from this dispatch, so nothing may report the step as running it.
    const applied = applyAgentVariant('shipped', replacing, 'mine')
    expect(applied.prompt).toBe('mine')
    expect(applied.applied).toBe('superseded')
    expect(applied.fingerprint).toBeUndefined()
  })

  it('reports a displaced replacement whose ADDITION survived as addition-only', () => {
    const applied = applyAgentVariant(
      'shipped',
      { ...replacing, promptAddition: 'In haiku.' },
      'mine',
    )
    expect(applied.prompt).toBe('mine\n\nIn haiku.')
    expect(applied.applied).toBe('addition-only')
  })

  it('fingerprints the CONTRIBUTION, so the displaced half is not counted in it', () => {
    // Kaizen keys on this: the surviving text is the addition alone, and a key that included the
    // dropped replacement would split the streak of two dispatches that ran identical prompts.
    const bothDeclared = { ...replacing, promptAddition: 'In haiku.' }
    expect(applyAgentVariant('shipped', bothDeclared, 'mine').fingerprint).toBe(
      applyAgentVariant('shipped', { id: 'v', baseKind: 'coder', promptAddition: 'In haiku.' })
        .fingerprint,
    )
  })

  it('changes the fingerprint when the variant is RE-WORDED under the same id', () => {
    // Re-registering an id is a supported way to re-word a variant, so the id alone cannot key a
    // verified combo — this is what stops a re-wording inheriting the old text's streak.
    const before = applyAgentVariant('shipped', { ...replacing, systemPrompt: 'Be a poet.' })
    const after = applyAgentVariant('shipped', { ...replacing, systemPrompt: 'Be a novelist.' })
    expect(before.fingerprint).toBeDefined()
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it('gives identical text the same fingerprint, so an unchanged variant keeps its combo', () => {
    expect(applyAgentVariant('shipped', replacing).fingerprint).toBe(
      applyAgentVariant('other shipped text', replacing).fingerprint,
    )
  })
})

describe('a variant composed the way a dispatch composes it', () => {
  /** What the engine hands the executor, then what the executor composes from it. */
  function composed(kind: string, variant: Parameters<typeof applyAgentVariant>[1]): string {
    const { prompt } = applyAgentVariant(shippedBasePromptFor(kind, registry), variant)
    return systemPromptFor(kind, registry, prompt)
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
    const { prompt } = applyAgentVariant(role, {
      id: 'v',
      baseKind: 'merger',
      promptAddition: 'Weigh migrations as high risk.',
    })
    expect(prompt).toBe(`${role}\n\nWeigh migrations as high risk.`)
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
