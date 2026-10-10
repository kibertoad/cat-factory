import { afterEach, describe, expect, it } from 'vitest'
import { DOC_KINDS } from '@cat-factory/contracts'
import {
  DOC_TEMPLATES,
  clearRegisteredDocTemplates,
  docTemplateFor,
  parseTemplateDocument,
  registerDocTemplate,
  renderTemplateSkeleton,
  requiredSectionTitles,
  resolveDocTemplate,
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

  describe('workspace-linked template resolution (WS1)', () => {
    it('parses a linked template document into required sections from its H2 headings', () => {
      const linked = [
        '# RFC: <title>',
        '',
        '## Context',
        'why',
        '## Proposal',
        'what',
        '## Rollout Plan',
        'how',
      ].join('\n')
      const template = parseTemplateDocument(linked, 'rfc')
      expect(template.kind).toBe('rfc')
      // The kind's canonical summary is preserved; sections come from the linked doc.
      expect(template.summary).toBe(DOC_TEMPLATES.rfc.summary)
      expect(template.sections.map((s) => s.title)).toEqual(['Context', 'Proposal', 'Rollout Plan'])
      expect(template.sections.every((s) => s.required)).toBe(true)
      // The parsed sections are the gate's required-section source of truth too.
      expect(requiredSectionTitles(template)).toEqual(['Context', 'Proposal', 'Rollout Plan'])
    })

    it('falls back to the built-in when a linked doc has no usable headings', () => {
      expect(parseTemplateDocument('just prose, no headings', 'adr')).toBe(DOC_TEMPLATES.adr)
    })

    it('falls back to the built-in for a lone-title document (a single heading, no sections)', () => {
      // A single heading is a bare title, not a section list — using it as the sole required
      // section would demand a heading matching the title, so resume the built-in skeleton.
      expect(parseTemplateDocument('# API Design Guidelines\n\nsome prose', 'adr')).toBe(
        DOC_TEMPLATES.adr,
      )
    })

    it('keeps the H2 sections when a titled template ends with H1 appendices', () => {
      // A `#` title + `##` sections + trailing `#` appendices: the sections are the H2s, not the
      // title + appendices (the writer prompt and the gate must not treat the title as a section).
      const linked = [
        '# RFC-1: Title',
        '## Summary',
        '## Motivation',
        '## Detailed design',
        '# Appendix A',
        '# Appendix B',
      ].join('\n')
      expect(parseTemplateDocument(linked, 'rfc').sections.map((s) => s.title)).toEqual([
        'Summary',
        'Motivation',
        'Detailed design',
      ])
    })

    it('treats repeated top-level headings with no title as the sections (flat template)', () => {
      const linked = ['# Summary', '# Motivation', '# Design'].join('\n')
      expect(parseTemplateDocument(linked, 'rfc').sections.map((s) => s.title)).toEqual([
        'Summary',
        'Motivation',
        'Design',
      ])
    })

    it('keeps H2 sections that carry their own H3 sub-headings (no H1 title)', () => {
      const linked = ['## Section One', '### detail', '## Section Two'].join('\n')
      expect(parseTemplateDocument(linked, 'rfc').sections.map((s) => s.title)).toEqual([
        'Section One',
        'Section Two',
      ])
    })

    it('ignores headings inside fenced code when parsing a linked template', () => {
      const linked = ['# Title', '## Real Section', '```md', '## Not A Section', '```'].join('\n')
      expect(parseTemplateDocument(linked, 'other').sections.map((s) => s.title)).toEqual([
        'Real Section',
      ])
    })

    it('resolveDocTemplate prefers a linked body, else the built-in fallback', () => {
      const linked = '# T\n\n## Alpha\n\n## Beta'
      expect(resolveDocTemplate('prd', linked).sections.map((s) => s.title)).toEqual([
        'Alpha',
        'Beta',
      ])
      // No/blank linked body ⇒ the built-in template for the kind.
      expect(resolveDocTemplate('prd')).toBe(DOC_TEMPLATES.prd)
      expect(resolveDocTemplate('prd', '   ')).toBe(DOC_TEMPLATES.prd)
    })
  })
})
