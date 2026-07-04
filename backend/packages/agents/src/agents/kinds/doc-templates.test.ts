import { afterEach, describe, expect, it } from 'vitest'
import { DOC_KINDS } from '@cat-factory/contracts'
import {
  DOC_TEMPLATES,
  clearRegisteredDocTemplates,
  docTemplateFor,
  registerDocTemplate,
  renderTemplateSkeleton,
  requiredSectionTitles,
  templateOutlineGuidance,
  templateSkeletonGuidance,
  templateStructureLine,
} from './doc-templates.js'

afterEach(() => {
  clearRegisteredDocTemplates()
})

describe('document templates', () => {
  it('ships a built-in template for every DocKind, each with at least one required section', () => {
    for (const kind of DOC_KINDS) {
      const template = DOC_TEMPLATES[kind]
      expect(template, `missing template for ${kind}`).toBeDefined()
      expect(template.kind).toBe(kind)
      expect(requiredSectionTitles(template).length).toBeGreaterThan(0)
    }
  })

  it('renders a skeleton with an H1 title and an H2 per section, marking optionals', () => {
    const skeleton = renderTemplateSkeleton(DOC_TEMPLATES.rfc, 'My RFC')
    expect(skeleton).toContain('# My RFC')
    expect(skeleton).toContain('## Summary')
    // "Drawbacks" is optional for an RFC and is flagged as such.
    expect(skeleton).toContain('## Drawbacks (optional)')
    // Required sections carry no marker.
    expect(skeleton).not.toContain('## Summary (optional)')
  })

  it('the structure line lists every section after the kind summary', () => {
    const line = templateStructureLine(DOC_TEMPLATES.adr)
    expect(line).toContain('an architecture decision record')
    expect(line).toContain('Decision')
    expect(line).toContain('Consequences')
  })

  it('outline guidance requires the required sections and offers the optional ones', () => {
    const guidance = templateOutlineGuidance(DOC_TEMPLATES.runbook)
    expect(guidance).toContain('MUST cover these required sections')
    expect(guidance).toContain('Escalation')
    // Rollback is optional for a runbook.
    expect(guidance).toContain('optional sections')
    expect(guidance).toContain('Rollback')
  })

  it('skeleton guidance embeds the rendered skeleton for the writer to start from', () => {
    const guidance = templateSkeletonGuidance(DOC_TEMPLATES.prd, 'Billing PRD')
    expect(guidance).toContain('template skeleton')
    expect(guidance).toContain('# Billing PRD')
    expect(guidance).toContain('## Acceptance Criteria')
  })

  it('a registered template overrides the built-in for its kind; unregistering falls back', () => {
    const custom = {
      kind: 'adr' as const,
      summary: 'a custom ADR',
      sections: [{ title: 'Only Section', guidance: 'the whole thing', required: true }],
    }
    expect(docTemplateFor('adr')).toBe(DOC_TEMPLATES.adr)
    registerDocTemplate(custom)
    expect(docTemplateFor('adr')).toBe(custom)
    expect(requiredSectionTitles(docTemplateFor('adr'))).toEqual(['Only Section'])
    // Other kinds are untouched by the override.
    expect(docTemplateFor('rfc')).toBe(DOC_TEMPLATES.rfc)
    clearRegisteredDocTemplates()
    expect(docTemplateFor('adr')).toBe(DOC_TEMPLATES.adr)
  })
})
