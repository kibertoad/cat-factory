import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import {
  appendContainerDispatchDirectives,
  baseSystemPromptFor,
  defaultAgentKindRegistry,
  EFFORT_REPORT_GUIDANCE,
  EXECUTION_SANDBOX_GUIDANCE,
  FINAL_ANSWER_IN_REPLY,
  INLINE_ENGINE_SYSTEM_PROMPTS,
  NO_ASSUMED_PRODUCT,
  READ_ONLY_GUARDRAIL,
  systemPromptFor,
} from '@cat-factory/agents'
import {
  BESPOKE_SYSTEM_PROMPTS,
  MERGER_DIRECTIVES,
  MERGER_SYSTEM_PROMPT,
  ON_CALL_SYSTEM_PROMPT,
  shippedBasePromptFor,
} from '@cat-factory/agents'
import { builtInDirectivesFor, dispatchSystemPromptFor } from '../src/agents/promptOverrides.js'

// The container-dispatch half of the per-workspace prompt override. Two properties matter and
// neither is obvious from the call sites: an override must not be able to delete the directives
// the ENGINE enforces, and the prompt the editor calls "the built-in" must be the prompt the
// container actually runs — including for the two kinds whose dispatch bypasses
// `systemPromptFor` and sends a bespoke constant.

const registry = defaultAgentKindRegistry()

/** `Object.entries` over a `Partial<Record<…>>` widens the value to `| undefined`; it never is. */
const bespokeEntries = Object.entries(BESPOKE_SYSTEM_PROMPTS).map(
  ([kind, prompt]) => [kind, prompt!] as const,
)

function context(agentKind: string, systemPromptOverride?: string): AgentRunContext {
  return {
    agentKind,
    pipelineName: 'p',
    stepIndex: 0,
    isFinalStep: false,
    block: { id: 'b', title: 't', description: '' },
    ...(systemPromptOverride ? { systemPromptOverride } : {}),
  } as unknown as AgentRunContext
}

describe('dispatchSystemPromptFor', () => {
  it('sends the shipped prompt when the workspace has no override', () => {
    expect(dispatchSystemPromptFor(context('coder'), registry)).toBe(
      systemPromptFor('coder', registry),
    )
  })

  it('replaces the track prompt with the override', () => {
    const prompt = dispatchSystemPromptFor(context('coder', 'Only touch one file.'), registry)
    expect(prompt).toContain('Only touch one file.')
    expect(prompt).not.toContain(baseSystemPromptFor('coder', registry))
  })

  it('still applies the engine-enforced directives on top of an override', () => {
    // The read-only guardrail (and the answer-in-your-reply rule) are how the platform runs a
    // kind, not editorial content. An override that could drop them would let a workspace turn a
    // read-only investigator into one that commits — a run-breaking edit made by accident.
    //
    // Measured through `builtInDirectivesFor`, NOT by slicing the base off the shipped prompt:
    // architect carries the answer-in-your-reply rule INLINE in its track prompt, so the slice
    // under-reports by exactly the invariant that used to go missing here.
    const directives = builtInDirectivesFor('architect', registry)
    expect(directives).toContain(READ_ONLY_GUARDRAIL)
    expect(directives).toContain(FINAL_ANSWER_IN_REPLY)
    // `appendContainerDispatchDirectives` closes the gap between the two: the measurement covers
    // the whole wire, and `dispatchSystemPromptFor` is only the first of the two seams that write
    // to it (`buildKindBody` adds the pair after it).
    expect(
      appendContainerDispatchDirectives(
        dispatchSystemPromptFor(context('architect', 'Think hard.'), registry),
      ),
    ).toBe(`Think hard.${directives}`)
  })

  it('overrides a bespoke kind ROLE while keeping its directives', () => {
    // The bespoke kinds bypass `applySurfaceDirectives` entirely, so their invariants live in a
    // declared `directives` half instead. Losing them is not a degraded prompt but a broken run:
    // without the answer-in-your-reply rule a reasoning model returns an empty visible reply the
    // harness reads as unusable, and without the JSON contract there is no assessment to parse.
    expect(dispatchSystemPromptFor(context('merger', 'Score generously.'), registry)).toBe(
      `Score generously.${MERGER_DIRECTIVES}`,
    )
  })

  it.each(bespokeEntries)(
    'keeps every invariant of the bespoke kind %s across an override',
    (kind, prompt) => {
      const overridden = dispatchSystemPromptFor(context(kind, 'Do it my way.'), registry)
      // Stated as the PROPERTY rather than as string equality, so a directive added to either
      // constant later is covered by this test without it being updated: the override replaces the
      // role half OUTRIGHT and the whole directives half survives it, byte for byte.
      expect(overridden.startsWith('Do it my way.')).toBe(true)
      expect(overridden).toContain(prompt.directives)
      expect(overridden).not.toContain(prompt.role)
      // Whatever else each family enforces, the invariant that has to survive is the one its
      // DELIVERABLE depends on, and the prompt declares which that is. A `reply` kind is parsed,
      // so its output contract must outlive the edit; a `side-effect` kind's product is a pushed
      // commit nothing is read back from, so it must NOT be carrying the answer-in-your-reply
      // rule (a kind that ends with no final text is not a failed run, and telling it otherwise
      // is how a legitimate empty reply becomes one).
      //
      // Read off `product` rather than asserted of every kind alike: the alternative to a
      // declared half is exempting the odd one out by name, which is the same test with the next
      // kind's mistake already excused.
      if (prompt.product === 'reply') {
        expect(overridden).toContain('code fences')
      } else {
        expect(overridden).not.toContain(FINAL_ANSWER_IN_REPLY)
      }
    },
  )

  it.each(['merger', 'on-call'] as const)(
    'keeps the answer-in-your-reply rule on the bespoke CONTAINER kind %s',
    (kind) => {
      // Container-specific: these two return a JSON assessment as their visible reply, and a
      // reasoning model that answers into its private channel fails the run outright.
      expect(dispatchSystemPromptFor(context(kind, 'Do it my way.'), registry)).toContain(
        FINAL_ANSWER_IN_REPLY,
      )
    },
  )

  it.each(['requirements-review', 'requirements-rework', 'requirements-writer'] as const)(
    'keeps the product/technical scope boundary and the no-assumed-product rule on %s',
    (kind) => {
      // The three requirements-flow prompts share both rules, and both only hold if all three
      // honour them — so neither may be editable away from any one of them.
      const overridden = dispatchSystemPromptFor(context(kind, 'Do it my way.'), registry)
      expect(overridden).toContain('THIS STAGE SETTLES PRODUCT AND BUSINESS REQUIREMENTS ONLY')
      expect(overridden).toContain(NO_ASSUMED_PRODUCT)
    },
  )

  it.each(Object.keys(INLINE_ENGINE_SYSTEM_PROMPTS))(
    'keeps the no-assumed-product rule on the inline engine kind %s',
    (kind) => {
      // Every inline reviewer / dialogue agent runs without a checkout, so none of them may be
      // edited into inventing the system it is reasoning about.
      expect(dispatchSystemPromptFor(context(kind, 'Do it my way.'), registry)).toContain(
        NO_ASSUMED_PRODUCT,
      )
    },
  )

  it('keeps the on-call read-only guardrail out of the editable half', () => {
    // on-call is the case that motivates the split: its guardrail is prose inside the constant
    // rather than a surface directive, so an un-split override would let a workspace turn a
    // read-only investigator into one that commits — by accident, while editing its wording.
    const { role, directives } = BESPOKE_SYSTEM_PROMPTS['on-call']!
    expect(role).not.toContain('MUST NOT modify')
    expect(directives).toContain('MUST NOT modify')
    expect(dispatchSystemPromptFor(context('on-call', 'Investigate fast.'), registry)).toContain(
      'MUST NOT modify',
    )
  })

  it('sends the bespoke constant, not the thin role prompt, when a bespoke kind is unedited', () => {
    // Byte-for-byte: an unedited workspace must send exactly what it sent before the split.
    expect(dispatchSystemPromptFor(context('merger'), registry)).toBe(MERGER_SYSTEM_PROMPT)
    expect(dispatchSystemPromptFor(context('on-call'), registry)).toBe(ON_CALL_SYSTEM_PROMPT)
    for (const [kind, prompt] of bespokeEntries) {
      expect(dispatchSystemPromptFor(context(kind), registry)).toBe(prompt.role + prompt.directives)
    }
  })
})

describe('builtInDirectivesFor', () => {
  it('is exactly what an override actually gets appended, on both paths', () => {
    // This is the contract the editor renders: "here is what the platform adds to whatever you
    // save". Asserted against the real dispatch so the shown text can never drift from the sent
    // text — which is the whole reason it is measured rather than written out as copy.
    //
    // Composed through `appendContainerDispatchDirectives` because `dispatchSystemPromptFor` is not
    // the last thing that appends to a container prompt: `buildKindBody` adds the sandbox contract
    // and the effort report after it. Measuring only the first seam under-reported the wire by the
    // length of that pair, and the editor promised a shorter contract than the run sends.
    for (const kind of ['coder', 'architect', 'spec-writer', 'merger', 'on-call']) {
      expect(
        appendContainerDispatchDirectives(
          dispatchSystemPromptFor(context(kind, 'My own prompt.'), registry),
        ),
      ).toBe(`My own prompt.${builtInDirectivesFor(kind, registry)}`)
    }
  })

  it('reports the container-dispatch pair for a container kind and withholds it from an inline one', () => {
    // Both halves matter. A container kind's override cannot delete the sandbox contract, so the
    // editor has to show it; an INLINE kind (a requirements reviewer driven as a bare LLM call)
    // never reaches the chokepoint at all, so showing it there would promise text no run sends.
    for (const kind of ['coder', 'architect', 'merger', 'on-call']) {
      expect(builtInDirectivesFor(kind, registry)).toContain(EXECUTION_SANDBOX_GUIDANCE)
      expect(builtInDirectivesFor(kind, registry)).toContain(EFFORT_REPORT_GUIDANCE)
    }
    for (const kind of ['requirements-reviewer', 'clarity-reviewer']) {
      expect(builtInDirectivesFor(kind, registry)).not.toContain(EXECUTION_SANDBOX_GUIDANCE)
    }
  })

  it('reports the answer-in-your-reply rule for every kind whose deliverable is its reply', () => {
    // architect + spec-writer carry it INLINE in their track prompts rather than appended, so a
    // naive "diff the shipped prompt against its base" would report nothing for them — and the
    // editor would promise a rule the override had in fact deleted.
    for (const kind of ['architect', 'spec-writer', 'merger', 'on-call']) {
      expect(builtInDirectivesFor(kind, registry)).toContain(FINAL_ANSWER_IN_REPLY)
    }
  })

  it('reports the trait guidance a kind gets even when it has no surface directives', () => {
    // The coder's product is a pushed commit, so it gets neither the final-answer rule nor the
    // read-only guardrail — but it IS handed its traits' guidance (spec-aware, …), which is just
    // as non-editable. The editor shows whatever is actually appended, not a curated subset.
    const directives = builtInDirectivesFor('coder', registry)
    expect(directives).not.toContain(FINAL_ANSWER_IN_REPLY)
    expect(directives).not.toContain(READ_ONLY_GUARDRAIL)
    expect(directives.trim()).not.toBe('')
  })
})

describe('shippedBasePromptFor', () => {
  it('is the text the dispatch runs for an unedited kind, so a restore restores what ran', () => {
    // This is the invariant the editor's "built-in" baseline rests on. It holds trivially for a
    // normal kind and is the whole reason the bespoke map exists for the other two.
    for (const kind of ['coder', 'architect', ...Object.keys(BESPOKE_SYSTEM_PROMPTS)]) {
      const builtIn = shippedBasePromptFor(kind, registry)
      expect(dispatchSystemPromptFor(context(kind, builtIn), registry)).toBe(
        dispatchSystemPromptFor(context(kind), registry),
      )
    }
  })
})
