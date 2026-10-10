import type { DocKind } from '@cat-factory/kernel'
import { documentHeadings } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Per-`DocKind` document TEMPLATES: the structured skeleton (required + optional
// sections, each with a one-line authoring note) a document of that kind should follow.
//
// This upgrades the one-line `DOC_KIND_STRUCTURE` hint in ./document.ts into a real,
// machine-readable template that is the SINGLE SOURCE OF TRUTH for a kind's expected
// shape. It has two consumers today and a third planned:
//   - the `doc-outliner` prompt — the outline must cover the required sections;
//   - the `doc-writer` prompt — start from the rendered skeleton;
//   - (later) the `doc-quality` gate — the required-section list is the gate's check,
//     read from HERE rather than duplicated (see docs/initiatives/document-task-improvements.md).
//
// The built-in `DOC_TEMPLATES` below are the FALLBACK. A deployment overrides a kind's
// template via the public `registerDocTemplate` seam (an import side effect, mirroring
// `registerPromptFragment` / `registerAgentKind`); a later per-workspace linked-document
// override (WS1 items 2–3) resolves ahead of both, but always through `docTemplateFor`.
//
// NOTE (registry-DI): like the still-module-global `registerPromptFragment` seam, this is a
// module-global registry. The agent-kind + agent-trait seams have already migrated to the
// app-owned `AgentKindRegistry` instance; when the registry-DI migration
// (docs/initiatives/registry-di-migration.md) reaches the remaining `@cat-factory/agents`
// seams, this one migrates with them — it deliberately copies their current shape rather than
// inventing a divergent one.
// ---------------------------------------------------------------------------

/** One section of a document template: the heading a document should carry + why. */
export interface DocTemplateSection {
  /** The section heading text (rendered as an H2 and matched by the quality gate). */
  title: string
  /** A one-line note on what the section covers, shown to the outliner/writer as guidance. */
  guidance: string
  /** Required sections must appear; optional ones are included when they add value. */
  required: boolean
}

/** A document template: the ordered sections expected for a {@link DocKind}. */
export interface DocTemplate {
  kind: DocKind
  /** A one-line description of the document kind (folded into the brief). */
  summary: string
  /** The ordered sections, required first is not enforced — author order is meaningful. */
  sections: DocTemplateSection[]
}

const req = (title: string, guidance: string): DocTemplateSection => ({
  title,
  guidance,
  required: true,
})
const opt = (title: string, guidance: string): DocTemplateSection => ({
  title,
  guidance,
  required: false,
})

/**
 * The built-in template for each document kind — the fallback skeleton when no deployment
 * or workspace override is registered. Keyed by every {@link DocKind} so a new kind is a
 * compile error until it has a template.
 */
export const DOC_TEMPLATES: Record<DocKind, DocTemplate> = {
  prd: {
    kind: 'prd',
    summary: 'a product requirements document',
    sections: [
      req('Overview', 'One-paragraph summary of what is being built and why.'),
      req('Problem & Goals', 'The problem being solved and the goals success is measured against.'),
      req('Target Users', 'Who this is for and the jobs they are trying to do.'),
      req('User Stories', 'The key user stories / scenarios the product must support.'),
      req('Scope', 'What is in scope and, explicitly, what is out of scope.'),
      req('Functional Requirements', 'The concrete capabilities the product must provide.'),
      req('Acceptance Criteria', 'Testable conditions that define "done" for each requirement.'),
      req('Success Metrics', 'The measurable outcomes that indicate the product is working.'),
      opt('Risks & Open Questions', 'Known risks, assumptions, and questions still to resolve.'),
    ],
  },
  rfc: {
    kind: 'rfc',
    summary: 'an RFC / design proposal',
    sections: [
      req('Summary', 'A short abstract of the proposal a reader can grasp in one paragraph.'),
      req('Motivation', 'Why this change is worth making and what problem it addresses.'),
      req('Detailed Design', 'The proposed design in enough detail to implement and critique.'),
      req(
        'Alternatives Considered',
        'The other approaches weighed, with the trade-offs that ruled them out.',
      ),
      opt('Drawbacks', 'The costs and downsides of the proposed approach.'),
      opt('Migration & Rollout', 'How the change is adopted, migrated to, and rolled out safely.'),
      opt('Unresolved Questions', 'The open questions to settle before or during implementation.'),
    ],
  },
  adr: {
    kind: 'adr',
    summary: 'an architecture decision record',
    sections: [
      req('Status', 'Proposed / accepted / superseded, with the date.'),
      req('Context', 'The forces and constraints that make a decision necessary.'),
      req('Decision', 'The decision that was made, stated in active voice.'),
      req(
        'Considered Options',
        'The options evaluated, each with its trade-offs, including the chosen one.',
      ),
      req('Consequences', 'The resulting context — the positive and negative outcomes.'),
    ],
  },
  design: {
    kind: 'design',
    summary: 'a technical design document',
    sections: [
      req('Overview', 'A short summary of what is being designed and the outcome.'),
      req('Goals & Non-Goals', 'What the design must achieve and, explicitly, what it will not.'),
      req('Architecture', 'The overall structure — the components and how they fit together.'),
      req('Key Components & Data Flows', 'The main components and how data moves between them.'),
      opt('Interfaces', 'The APIs, contracts, and boundaries between components.'),
      opt('Alternatives', 'Alternative designs considered and why they were not chosen.'),
      opt('Risks', 'The technical risks and how they are mitigated.'),
    ],
  },
  technical: {
    kind: 'technical',
    summary: 'a technical reference',
    sections: [
      req('Purpose', 'What this reference covers and who should read it.'),
      req('Concepts', 'The concepts and terminology a reader needs to understand first.'),
      req('Usage', 'Step-by-step usage instructions, in order.'),
      req('Examples', 'Concrete, runnable examples that show the common cases.'),
      opt('Configuration', 'The configuration options and their effects.'),
      opt('Troubleshooting', 'Common problems and how to resolve them.'),
    ],
  },
  api: {
    kind: 'api',
    summary: 'an API reference',
    sections: [
      req('Overview & Authentication', 'What the API does and how a caller authenticates.'),
      req(
        'Endpoints',
        'Each endpoint/operation: request, parameters, and response, with a worked example.',
      ),
      req('Errors', 'The error responses, their status codes, and their meanings.'),
      req('Examples', 'End-to-end worked examples covering the common flows.'),
    ],
  },
  runbook: {
    kind: 'runbook',
    summary: 'an operational runbook',
    sections: [
      req('When to Use', 'The trigger or situation this runbook applies to.'),
      req('Prerequisites', 'The access, tools, and preconditions needed before starting.'),
      req('Procedure', 'The numbered, step-by-step procedure to follow.'),
      req('Verification', 'How to confirm the procedure worked.'),
      req('Escalation', 'Who to contact and how to escalate if the procedure fails.'),
      opt('Rollback', 'How to safely undo the procedure if needed.'),
    ],
  },
  research: {
    kind: 'research',
    summary: 'a research / analysis report',
    sections: [
      req('Question', 'The question or hypothesis the research set out to answer.'),
      req('Method', 'How the research was conducted and what sources were consulted.'),
      req('Findings', 'What the research found, organised for the reader.'),
      req('Options Compared', 'The options weighed against each other, with their trade-offs.'),
      req('Recommendation', 'The recommended course of action and the reasoning for it.'),
      opt('References', 'The sources cited, linked where possible.'),
    ],
  },
  reference: {
    kind: 'reference',
    summary: 'a reference document organised by topic',
    sections: [
      req('Overview', 'A short orientation and a map of the topics that follow.'),
      req('Topics', 'The reference content, organised into clearly-headed topic sections.'),
    ],
  },
  other: {
    kind: 'other',
    summary: 'a well-structured document',
    sections: [
      req('Overview', 'A short summary of the document up front.'),
      req('Details', 'The body of the document, organised into clearly-headed sections.'),
    ],
  },
}

// Deployment-level override registry, mirroring `registerPromptFragment`. A registered
// template for a kind shadows the built-in; re-registering replaces it.
const registered = new Map<DocKind, DocTemplate>()

/** Register a custom document template for a kind. Re-registering the kind replaces it. */
export function registerDocTemplate(template: DocTemplate): void {
  registered.set(template.kind, template)
}

/** Register several custom document templates at once. */
export function registerDocTemplates(templates: Iterable<DocTemplate>): void {
  for (const template of templates) registerDocTemplate(template)
}

/** Drop all registered template overrides. Intended for tests that exercise registration. */
export function clearRegisteredDocTemplates(): void {
  registered.clear()
}

/**
 * The effective template for a document kind: a deployment-registered override when one
 * exists, otherwise the built-in fallback. This is the single entry point both the prompts
 * and (later) the quality gate resolve through, so a future workspace-linked override only
 * has to slot in here.
 */
export function docTemplateFor(kind: DocKind): DocTemplate {
  return registered.get(kind) ?? DOC_TEMPLATES[kind]
}

/**
 * The heading level that carries a linked template's SECTIONS. A single top-level `#` heading
 * LEADING the document is its TITLE, so the sections are the shallowest level below it — the
 * typical `# Title` + `## Section`s shape. Trailing top-level headings AFTER the sections (e.g.
 * `# Appendix A`) don't disqualify the title: only the number of top-level headings BEFORE the
 * first sub-heading decides, so a title + `##` sections + `#` appendices still yields the `##`
 * sections (not the title + appendices). A document whose shallowest level is deeper than `#`, or
 * has no sub-headings, is flat — its sections ARE that shallowest level (so `## S1` + `### detail`
 * + `## S2` keeps the `##` sections). Returns null when there is no section structure to read: no
 * headings at all, or a single lone heading (a bare title).
 */
function templateSectionLevel(headings: { level: number }[]): number | null {
  // No headings, or a single lone heading (a bare title) — no section list to derive.
  if (headings.length <= 1) return null
  const levels = headings.map((h) => h.level)
  const minLevel = Math.min(...levels)
  const firstSubIndex = levels.findIndex((l) => l > minLevel)
  // No sub-headings: the document is flat — its sections ARE the shallowest level.
  if (firstSubIndex === -1) return minLevel
  // A lone leading `#` title (exactly one top-level heading before the first sub-heading) means the
  // sections are the shallowest sub-level; otherwise the shallowest level already holds the sections.
  const topBeforeFirstSub = levels.slice(0, firstSubIndex).filter((l) => l === minLevel).length
  return minLevel === 1 && topBeforeFirstSub === 1
    ? Math.min(...levels.filter((l) => l > minLevel))
    : minLevel
}

/**
 * Parse a workspace-linked TEMPLATE document (raw Markdown) into a {@link DocTemplate} for a kind
 * (WS1 item 3): its section headings become the required sections, so the SAME parsed sections
 * feed both the author prompts and the `doc-quality` gate. Uses the kernel heading extractor the
 * gate uses (no second Markdown parser) and keeps the kind's canonical `summary`. Falls back to
 * the built-in template when the document carries no usable headings.
 */
export function parseTemplateDocument(markdown: string, kind: DocKind): DocTemplate {
  const headings = documentHeadings(markdown)
  const level = templateSectionLevel(headings)
  if (level === null) return docTemplateFor(kind)
  const sections = headings
    .filter((h) => h.level === level && h.text.trim().length > 0)
    .map((h) => ({ title: h.text.trim(), guidance: '', required: true }))
  if (sections.length === 0) return docTemplateFor(kind)
  return { kind, summary: docTemplateFor(kind).summary, sections }
}

/**
 * The effective template for a kind given an OPTIONAL workspace-linked template body: the linked
 * document's parsed sections when one is linked, else the built-in / deployment-registered
 * fallback. THE single resolution seam both the doc-authoring prompts (via the engine-resolved
 * `context.block.docTemplateBody`) and the `doc-quality` gate provider go through — do not add a
 * parallel resolution path.
 */
export function resolveDocTemplate(kind: DocKind, linkedTemplateBody?: string | null): DocTemplate {
  const body = linkedTemplateBody?.trim()
  return body ? parseTemplateDocument(body, kind) : docTemplateFor(kind)
}

/** The titles of a template's required sections — the source of truth for the quality gate. */
export function requiredSectionTitles(template: DocTemplate): string[] {
  return template.sections.filter((s) => s.required).map((s) => s.title)
}

/**
 * A one-line "produce X: section, section, …" description of a template, woven into the
 * shared document brief every doc-kind prompt reads. Keeps the template the single source
 * of the kind's shape (the researcher/finalizer see the section list here, the outliner and
 * writer get the fuller guidance below).
 */
export function templateStructureLine(template: DocTemplate): string {
  return `${template.summary}: ${template.sections.map((s) => s.title).join(', ')}`
}

/**
 * Render a template as a Markdown skeleton: an H1 title placeholder followed by each
 * section as an H2 with its guidance as an inline note. Optional sections are marked so the
 * author knows they can be dropped. Used verbatim in the writer prompt as a starting point.
 */
export function renderTemplateSkeleton(template: DocTemplate, title = '<Document title>'): string {
  const lines: string[] = [`# ${title}`, '']
  for (const section of template.sections) {
    const marker = section.required ? '' : ' (optional)'
    lines.push(`## ${section.title}${marker}`, '')
    // A workspace-linked template's parsed sections carry no per-section guidance — skip the
    // empty italic note rather than rendering a bare `__`.
    if (section.guidance) lines.push(`_${section.guidance}_`, '')
  }
  return lines.join('\n').trimEnd()
}

/**
 * The outliner-facing guidance for a template: the required sections the outline must cover
 * and the optional ones it may add. Kept terse — the outliner produces structure, not prose.
 */
export function templateOutlineGuidance(template: DocTemplate): string {
  const required = template.sections.filter((s) => s.required)
  const optional = template.sections.filter((s) => !s.required)
  const bullet = (s: DocTemplateSection): string =>
    s.guidance ? `- ${s.title} — ${s.guidance}` : `- ${s.title}`
  const lines = [
    `This is ${template.summary}. The outline MUST cover these required sections (in a sensible order, renamed only if the meaning is preserved):`,
    ...required.map(bullet),
  ]
  if (optional.length) {
    lines.push('Include these optional sections where they add value:')
    lines.push(...optional.map(bullet))
  }
  return lines.join('\n')
}

/**
 * The writer-facing guidance for a template: the skeleton to start from and the instruction
 * to fill every required section. The approved outline still leads; the skeleton is the
 * baseline the outline refined.
 */
export function templateSkeletonGuidance(template: DocTemplate, title: string): string {
  return [
    `Start from this ${template.kind} template skeleton and fill in every required section (drop or add optional sections as the outline dictates):`,
    '',
    renderTemplateSkeleton(template, title),
  ].join('\n')
}
