import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import {
  canParkOnHuman,
  isHeadlessInlinePipeline,
  isInlineOnlyPipeline,
} from './publicApiAdmission.js'

// The public-API admission policy. Two INDEPENDENT halves, and the whole point of slice 1 is that
// they stopped being one flat refusal:
//
//  - inline-only is ABSOLUTE (no scope lifts it) — an external key must never trigger container
//    work or a GitHub write through the initiative surface;
//  - parking is a SCOPE question — a pipeline that can park needs a caller able to answer, which
//    is exactly what a `decide` key asserts.
//
// These live here rather than in the cross-runtime conformance suite because the built-in public
// pipeline is read-only: there is no way to construct a public-and-parking pipeline over HTTP, so
// the cases that matter most would be untestable through the wire. The logic is pure and lives in
// the shared controller layer, so it cannot drift between facades either way.

const registry = defaultAgentKindRegistry()

describe('public-API admission', () => {
  describe('isInlineOnlyPipeline', () => {
    it('accepts a chain of inline engine kinds', () => {
      expect(
        isInlineOnlyPipeline({ agentKinds: ['initiative-breakdown', 'task-estimator'] }, registry),
      ).toBe(true)
    })

    it('rejects a chain containing a container/repo step', () => {
      // The non-negotiable half: `coder` clones and pushes, so no key of any scope may launch it
      // through the initiative surface.
      expect(isInlineOnlyPipeline({ agentKinds: ['coder'] }, registry)).toBe(false)
      expect(
        isInlineOnlyPipeline({ agentKinds: ['initiative-breakdown', 'coder'] }, registry),
      ).toBe(false)
    })

    it('ignores DISABLED steps, which never run', () => {
      // A disabled step stays in the chain for editing but is skipped at run time, so it must not
      // veto admission — otherwise a pipeline whose container step was turned off would be
      // permanently unlaunchable for no reason.
      expect(
        isInlineOnlyPipeline(
          { agentKinds: ['initiative-breakdown', 'coder'], enabled: [true, false] },
          registry,
        ),
      ).toBe(true)
    })

    it('rejects a pipeline with no enabled steps at all', () => {
      expect(isInlineOnlyPipeline({ agentKinds: [] }, registry)).toBe(false)
      expect(
        isInlineOnlyPipeline({ agentKinds: ['initiative-breakdown'], enabled: [false] }, registry),
      ).toBe(false)
    })

    it('rejects an unknown kind rather than assuming it is harmless', () => {
      expect(isInlineOnlyPipeline({ agentKinds: ['not-a-real-kind'] }, registry)).toBe(false)
    })
  })

  describe('canParkOnHuman', () => {
    it('detects each inline-and-parking kind', () => {
      // All four set the run `blocked` awaiting a human. Missing any one of them would silently
      // admit a hanging pipeline for a plain `write` key — the exact regression the set guards.
      for (const kind of [
        'requirements-review',
        'clarity-review',
        'requirements-brainstorm',
        'architecture-brainstorm',
      ]) {
        expect(canParkOnHuman({ agentKinds: [kind] }), kind).toBe(true)
      }
    })

    it('detects an approval gate on an enabled step', () => {
      // A gate parks the run just as surely as a review kind does, on an otherwise ordinary step.
      expect(canParkOnHuman({ agentKinds: ['initiative-breakdown'], gates: [true] })).toBe(true)
    })

    it('ignores a gate on a DISABLED step (index-aligned with the original chain)', () => {
      // `gates` is parallel to the ORIGINAL `agentKinds`, so the alignment has to survive
      // filtering — reading the gate array by the FILTERED index would look at the wrong step.
      expect(
        canParkOnHuman({
          agentKinds: ['initiative-breakdown', 'task-estimator'],
          enabled: [true, false],
          gates: [false, true],
        }),
      ).toBe(false)
      expect(
        canParkOnHuman({
          agentKinds: ['initiative-breakdown', 'task-estimator'],
          enabled: [false, true],
          gates: [true, false],
        }),
      ).toBe(false)
    })

    it('ignores a parking kind on a disabled step', () => {
      expect(
        canParkOnHuman({
          agentKinds: ['initiative-breakdown', 'requirements-review'],
          enabled: [true, false],
        }),
      ).toBe(false)
    })

    it('is false for an ordinary non-parking chain', () => {
      expect(canParkOnHuman({ agentKinds: ['initiative-breakdown'] })).toBe(false)
    })
  })

  describe('isHeadlessInlinePipeline (the `headlessStartable` discovery flag)', () => {
    it('is true only when the pipeline is both inline-only and non-parking', () => {
      // This is what a `write`-scope caller can drive end to end with no follow-up. A parking
      // pipeline is still ADMISSIBLE for a `decide` key — it just is not headless-startable.
      expect(isHeadlessInlinePipeline({ agentKinds: ['initiative-breakdown'] }, registry)).toBe(
        true,
      )
      expect(isHeadlessInlinePipeline({ agentKinds: ['requirements-review'] }, registry)).toBe(
        false,
      )
      expect(
        isHeadlessInlinePipeline({ agentKinds: ['initiative-breakdown'], gates: [true] }, registry),
      ).toBe(false)
      expect(isHeadlessInlinePipeline({ agentKinds: ['coder'] }, registry)).toBe(false)
    })
  })
})
