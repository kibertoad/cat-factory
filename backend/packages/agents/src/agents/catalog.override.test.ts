import { describe, expect, it } from 'vitest'
import { baseSystemPromptFor, systemPromptFor } from './catalog.js'
import { defaultAgentKindRegistry } from './kinds/registry.js'
import { FINAL_ANSWER_IN_REPLY } from './prompts/shared.js'
import { TRIAGE_JSON_CONTRACT } from './prompts/roles.js'
import { READ_ONLY_GUARDRAIL } from './kinds/read-only.js'

// `systemPromptFor`'s `override` parameter is the per-workspace agent prompt override (a
// workspace replaces a kind's track prompt from the pipeline builder). The property under test
// is the one the whole feature rests on: an override changes what an agent is TOLD TO BE, never
// how the platform RUNS it.
//
// The trap these cover is that the platform's invariants reach a shipped prompt by TWO routes —
// appended by `applySurfaceDirectives`, or written INLINE into a built-in track prompt — and only
// the first route survives having the track prompt replaced. The inline case is invisible from
// the call site and silent at runtime: the run does not error, it just comes back with an empty
// visible reply (or an un-guardrailed read-only agent) on a workspace that edited a prompt.

const registry = defaultAgentKindRegistry()

/** Kinds whose deliverable IS their visible reply, so losing the rule breaks the run. */
const REPLY_DELIVERABLE_KINDS = ['architect', 'spec-writer', 'task-estimator', 'reviewer']

describe('systemPromptFor override', () => {
  it('sends the shipped prompt byte-for-byte when there is no override', () => {
    for (const kind of [...REPLY_DELIVERABLE_KINDS, 'coder']) {
      const base = baseSystemPromptFor(kind, registry)
      expect(systemPromptFor(kind, registry).startsWith(base)).toBe(true)
    }
  })

  it('replaces the track prompt, so none of the shipped wording survives', () => {
    const overridden = systemPromptFor('architect', registry, 'Be brief.')
    expect(overridden.startsWith('Be brief.')).toBe(true)
    expect(overridden).not.toContain(baseSystemPromptFor('architect', registry))
  })

  it.each(REPLY_DELIVERABLE_KINDS)(
    'keeps the answer-in-your-reply rule on %s across an override',
    (kind) => {
      // Deliberately indifferent to HOW the rule reaches the shipped prompt — a built-in track
      // carries it inline, a registered kind has it appended — because the point is that both
      // routes used to lose it. `applySurfaceDirectives` gates the append on the base being the
      // REGISTRY's prompt: a double-append guard that, once an override replaces the base, reads
      // "it already has it" about a string that no longer exists (inline case) or fails its
      // identity check (registered case). Either way a reasoning model returns an empty visible
      // reply and the harness fails the run.
      expect(systemPromptFor(kind, registry)).toContain(FINAL_ANSWER_IN_REPLY)
      expect(systemPromptFor(kind, registry, 'Do it my way.')).toContain(FINAL_ANSWER_IN_REPLY)
    },
  )

  it('keeps the read-only guardrail on a read-only kind', () => {
    expect(systemPromptFor('architect', registry, 'Do it my way.')).toContain(READ_ONLY_GUARDRAIL)
  })

  it('keeps the estimator’s JSON contract across an override', () => {
    // The `task-estimator` is a PROMOTABLE Sandbox catalog kind whose prompt comes from a built-in
    // track, so the bespoke `{ role, directives }` split is not available to it and its output
    // contract sits inside the editable text. A promoted candidate that reworded the role would
    // otherwise take the shape `coerceTaskEstimate` parses with it, and the failure is silent: no
    // estimate is persisted, so every step gated on the estimate simply stops being gated.
    expect(systemPromptFor('task-estimator', registry)).toContain(TRIAGE_JSON_CONTRACT)
    expect(systemPromptFor('task-estimator', registry, 'Score it however you like.')).toContain(
      TRIAGE_JSON_CONTRACT,
    )
  })

  it('does not duplicate an invariant an override already restates', () => {
    // A user who pastes the shipped prompt, edits one line and saves would otherwise get two
    // copies of the rule — which reads to a model as emphasis on the wrong thing.
    const withRule = `Do it my way.\n\n${FINAL_ANSWER_IN_REPLY}`
    const composed = systemPromptFor('architect', registry, withRule)
    expect(composed.split(FINAL_ANSWER_IN_REPLY)).toHaveLength(2)
  })

  it('adds no reply rule to a kind that has none', () => {
    // The coder's product is a pushed commit; it legitimately ends with no final text, so
    // restoring a rule it never shipped with would change what an unedited neighbour sends.
    expect(baseSystemPromptFor('coder', registry)).not.toContain(FINAL_ANSWER_IN_REPLY)
    expect(systemPromptFor('coder', registry, 'Do it my way.')).not.toContain(FINAL_ANSWER_IN_REPLY)
  })

  it('restores the rule for a REGISTERED inline kind too', () => {
    // The other half of the same gate: for a registered kind the rule is APPENDED, and the guard
    // that appends it also keys off the base being the registry's prompt — so an override loses
    // it by the opposite route. Both are covered because the restore compares against the fully
    // composed shipped prompt rather than its base.
    const custom = defaultAgentKindRegistry()
    custom.register({
      kind: 'house-analyst',
      systemPrompt: 'You analyse things for us.',
      agent: { surface: 'inline' },
    })
    expect(systemPromptFor('house-analyst', custom)).toContain(FINAL_ANSWER_IN_REPLY)
    expect(systemPromptFor('house-analyst', custom, 'Analyse differently.')).toContain(
      FINAL_ANSWER_IN_REPLY,
    )
  })
})
