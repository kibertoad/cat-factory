import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { defineStructuredOutput } from './structured-output.js'
import { AgentKindRegistry } from './registry.js'

// Schema-driven structured output: one valibot schema replaces a hand-written shapeHint
// string + lenient coercer, and `registry.register` auto-derives `agent.output` from it.

const assessment = defineStructuredOutput(
  v.object({
    risk: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
    summary: v.optional(v.string()),
    findings: v.optional(
      v.array(
        v.object({
          title: v.fallback(v.string(), 'Untitled finding'),
          detail: v.optional(v.string()),
          severity: v.optional(v.picklist(['low', 'medium', 'high', 'critical'])),
        }),
      ),
      [],
    ),
  }),
)

describe('defineStructuredOutput', () => {
  it('derives a non-empty shapeHint and a structured spec', () => {
    expect(assessment.spec.kind).toBe('structured')
    expect(assessment.spec.shapeHint).toBeTruthy()
    // The walker reflects the schema's fields + the picklist union.
    expect(assessment.spec.shapeHint).toContain('"risk": number')
    expect(assessment.spec.shapeHint).toContain('"findings": [')
    expect(assessment.spec.shapeHint).toContain('"low"|"medium"|"high"|"critical"')
  })

  it('honours an explicit shapeHint override', () => {
    const out = defineStructuredOutput(v.object({ a: v.string() }), { shapeHint: 'CUSTOM' })
    expect(out.spec.shapeHint).toBe('CUSTOM')
  })

  it('safeParse is lenient (returns undefined on garbage, fills defaults otherwise)', () => {
    expect(assessment.safeParse('not json')).toBeUndefined()
    expect(assessment.safeParse(42)).toBeUndefined()
    const parsed = assessment.safeParse({ summary: 'ok' })
    expect(parsed).toEqual({ summary: 'ok', findings: [] })
  })

  it('parse throws on a value that violates the schema', () => {
    expect(() => assessment.parse({ risk: 5 })).toThrow()
    expect(() => assessment.parse('nope')).toThrow()
  })
})

describe('registry.register structuredOutput auto-fill', () => {
  it('derives agent.output from structuredOutput when not set by hand', () => {
    const registry = new AgentKindRegistry()
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore', clone: { branch: 'pr' } },
      structuredOutput: assessment,
    })
    expect(registry.agentStep('auditor')?.output).toEqual(assessment.spec)
    expect(registry.structuredOutput('auditor')?.safeParse({ summary: 'x' })).toEqual({
      summary: 'x',
      findings: [],
    })
  })

  it('does not override an explicit agent.output', () => {
    const registry = new AgentKindRegistry()
    const explicit = { kind: 'structured' as const, shapeHint: 'HAND' }
    registry.register({
      kind: 'auditor2',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore', output: explicit },
      structuredOutput: assessment,
    })
    expect(registry.agentStep('auditor2')?.output).toEqual(explicit)
  })
})
