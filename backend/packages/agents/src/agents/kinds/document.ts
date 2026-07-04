import type { AgentRunContext, DocKind } from '@cat-factory/kernel'
import { CONTEXT_BUDGET, estimateTokens } from '@cat-factory/kernel'
import type { AgentKindDefinition } from './registry.js'
import { registerAgentKinds } from './registry.js'
import { linkedContextSection } from '../prompts/standard.js'
import {
  docTemplateFor,
  templateOutlineGuidance,
  templateSkeletonGuidance,
  templateStructureLine,
} from './doc-templates.js'

// ---------------------------------------------------------------------------
// The document-authoring agent kinds — a FORWARD-authoring track whose deliverable IS an
// in-repo Markdown document (a PRD / RFC / design doc / ADR / technical reference / runbook /
// research report) shipped as a pull request, distinct from the reverse-documentation kinds
// (`documenter` / `business-documenter` / `blueprints`) that describe code that already exists.
//
// They are registered through the SAME public `registerAgentKind` seam a deployment uses
// (see `backend/internal/example-custom-agent`), so they become first-class palette blocks
// (via the workspace snapshot's `customAgentKinds`) with NO bespoke harness handler:
//   - `doc-researcher` / `doc-outliner` are INLINE (one-shot LLM, no checkout); their prose
//     output flows to the writer as prior-step context.
//   - `doc-writer` is CONTAINER-CODING with a non-`pr` clone, so the generic coding harness
//     branches off base, writes the Markdown file, pushes the work branch and OPENS a PR —
//     exactly the coder lifecycle (`ContainerAgentExecutor.buildRegisteredAgentBody`). Its
//     companion `doc-reviewer` (see ./companions) rates the draft and loops it back for rework.
//   - `doc-finalizer` is CONTAINER-CODING with a `pr` clone, so it polishes in place on the
//     doc PR branch and pushes back (no new PR), fixer-like — it also folds in the human
//     gate's revision feedback (threaded automatically by `withRevision`).
//
// The merge tail (`conflicts → ci → merger`) then ships the document PR like any other.
// Nothing is persisted to a new table: the committed Markdown is the durable artifact.
// ---------------------------------------------------------------------------

export const DOC_RESEARCHER_KIND = 'doc-researcher'
export const DOC_OUTLINER_KIND = 'doc-outliner'
export const DOC_WRITER_KIND = 'doc-writer'
export const DOC_FINALIZER_KIND = 'doc-finalizer'
/** The companion that reviews {@link DOC_WRITER_KIND}; its definition lives in ./companions. */
export const DOC_REVIEWER_KIND = 'doc-reviewer'

/** Filesystem-safe slug for a document title (the default file name under `docs/<kind>/`). */
function docSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'document'
}

/** The default in-repo directory each document kind is written under (overridable per task). */
const DOC_KIND_DIR: Record<DocKind, string> = {
  prd: 'docs/prd',
  rfc: 'docs/rfc',
  adr: 'docs/adr',
  design: 'docs/design',
  technical: 'docs/technical',
  api: 'docs/api',
  runbook: 'docs/runbooks',
  research: 'docs/research',
  reference: 'docs/reference',
  other: 'docs',
}

/** The document fields on the task, defaulting `docKind` to `other` when unset. */
function docFields(context: AgentRunContext): {
  docKind: DocKind
  audience?: string
  targetPath: string
  outlineHints?: string
} {
  const fields = context.block.taskTypeFields
  const docKind = (fields?.docKind ?? 'other') as DocKind
  const targetPath =
    fields?.targetPath?.trim() || `${DOC_KIND_DIR[docKind]}/${docSlug(context.block.title)}.md`
  return {
    docKind,
    audience: fields?.audience?.trim() || undefined,
    targetPath,
    outlineHints: fields?.outlineHints?.trim() || undefined,
  }
}

/**
 * The shared "what document are we writing" brief woven into every doc-kind prompt.
 *
 * `structure: 'full'` (the default) spells out the section list via `templateStructureLine` —
 * the researcher/finalizer get ONLY this brief, so they need it. The outliner/writer pass
 * `structure: 'summary'` because they also receive the fuller template guidance below
 * (`templateOutlineGuidance` / `templateSkeletonGuidance`), so repeating the section list in
 * the brief would just spend tokens with no added signal.
 */
function docBriefSection(
  context: AgentRunContext,
  opts: { materialized?: boolean; structure?: 'full' | 'summary' },
): string {
  const { docKind, audience, targetPath, outlineHints } = docFields(context)
  const template = docTemplateFor(docKind)
  const structure =
    opts.structure === 'summary' ? template.summary : templateStructureLine(template)
  const lines: string[] = [
    `Document title: ${context.block.title}`,
    `Document kind: ${docKind} — produce ${structure}.`,
    `Target file: \`${targetPath}\` (Markdown).`,
  ]
  if (audience) lines.push(`Intended audience: ${audience}. Pitch the depth and tone for them.`)
  lines.push(
    `Brief / requirements: ${context.block.description?.trim() || '(none provided — infer from the title and any linked context)'}`,
  )
  if (outlineHints) lines.push(`Author-provided outline hints: ${outlineHints}`)
  const linked = linkedContextSection(context, opts)
  if (linked) lines.push(linked)
  return lines.join('\n')
}

/**
 * Render the prior steps' work (the research brief, the approved outline) for a later step,
 * trimmed to a shared token budget so a long research brief + outline + writer summary +
 * reviewer feedback can't bloat the prompt unbounded (the writer/finalizer also receive the
 * materialised linked context, which is budgeted separately). Each section is clamped to what
 * remains, oldest-first, with a marker when truncated.
 */
function priorWorkSection(context: AgentRunContext): string {
  if (!context.priorOutputs.length) return ''
  const lines = ['', 'Work from earlier steps in this pipeline (build on it, do not repeat it):']
  let remaining = CONTEXT_BUDGET.inlineBodyTokens
  for (const p of context.priorOutputs) {
    if (remaining <= 0) {
      lines.push('### (earlier steps omitted — prior-work budget reached)')
      break
    }
    const body = clampToBudget(p.output ?? '', remaining)
    remaining -= estimateTokens(body)
    lines.push(`### ${p.agentKind}`, body)
  }
  return lines.join('\n')
}

/** Clamp text to roughly `maxTokens`, appending an ellipsis marker when it was cut. */
function clampToBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  // estimateTokens is ~chars/4, so budget the character slice the same way.
  const maxChars = Math.max(0, maxTokens * 4)
  return `${text.slice(0, maxChars).trimEnd()}\n…(truncated)`
}

const DOC_RESEARCHER_SYSTEM_PROMPT =
  'You are a documentation researcher. Before a document is drafted, investigate everything ' +
  'needed to write it well: the problem space, prior art, any linked requirements / RFCs / ' +
  'tracker issues, relevant standards and constraints, and the open questions a good author ' +
  'would need answered. Produce a concise, well-organised research brief — facts, sources and ' +
  'the key decisions to make — NOT the document itself. Flag gaps and assumptions explicitly.'

const DOC_OUTLINER_SYSTEM_PROMPT =
  'You are a documentation outliner. Turn the brief and any research into a clear, ' +
  'kind-appropriate outline for the document: the ordered sections with a one-line statement ' +
  'of what each will cover, plus any cross-cutting notes (terminology, diagrams to include, ' +
  'open questions to resolve). The outline is reviewed by a human before drafting, so make it ' +
  'specific and easy to critique. Do NOT write the prose — only the structure.'

const DOC_WRITER_SYSTEM_PROMPT =
  'You are a senior technical writer. Write the complete document as Markdown, following the ' +
  'approved outline and folding in the research and any linked context. Write the file at the ' +
  'target path given in the task (create the directory as needed); write ONLY that document — ' +
  'do not touch code or unrelated files. Lead with a short overview/summary, use clear headings, ' +
  'concrete examples and tables where they help, and keep the prose precise and self-contained. ' +
  'When the document describes the codebase, read the relevant code to get details right. The ' +
  'platform commits your file and opens the pull request — do not run git yourself.'

const DOC_FINALIZER_SYSTEM_PROMPT =
  'You are a documentation editor doing the final pass on a drafted document. Improve clarity, ' +
  'consistency and flow; fix structure, headings, terminology, links and formatting; tighten the ' +
  'overview/summary; and resolve any reviewer feedback. Preserve the substance — do not rewrite ' +
  'from scratch or change the meaning. Edit the existing document file in place and only that ' +
  'file. The platform commits and pushes your changes — do not run git yourself.'

function docResearcherUserPrompt(context: AgentRunContext): string {
  return [
    `Pipeline: ${context.pipelineName}`,
    docBriefSection(context, {}),
    '',
    'Produce the research brief for this document. Be concise and concrete.',
  ].join('\n')
}

function docOutlinerUserPrompt(context: AgentRunContext): string {
  const { docKind } = docFields(context)
  return [
    `Pipeline: ${context.pipelineName}`,
    docBriefSection(context, { structure: 'summary' }),
    priorWorkSection(context),
    '',
    templateOutlineGuidance(docTemplateFor(docKind)),
    '',
    'Produce the outline (sections + one-line intent each). Do not write the prose.',
  ].join('\n')
}

function docWriterUserPrompt(context: AgentRunContext): string {
  const { docKind, targetPath } = docFields(context)
  return [
    `Pipeline: ${context.pipelineName}`,
    docBriefSection(context, { materialized: true, structure: 'summary' }),
    priorWorkSection(context),
    '',
    templateSkeletonGuidance(docTemplateFor(docKind), context.block.title),
    '',
    `Write the full document to \`${targetPath}\` as Markdown, following the approved outline. ` +
      'The outline leads where it refined the skeleton; cover every required section.',
  ].join('\n')
}

function docFinalizerUserPrompt(context: AgentRunContext): string {
  const { targetPath } = docFields(context)
  return [
    `Pipeline: ${context.pipelineName}`,
    docBriefSection(context, { materialized: true }),
    priorWorkSection(context),
    '',
    `Polish the document at \`${targetPath}\` — clarity, consistency, structure and formatting — ` +
      'and apply any reviewer feedback. Edit it in place; do not rewrite from scratch.',
  ].join('\n')
}

/** The document-authoring kinds (the companion `doc-reviewer` is defined in ./companions). */
export const DOCUMENT_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: DOC_RESEARCHER_KIND,
    systemPrompt: DOC_RESEARCHER_SYSTEM_PROMPT,
    userPrompt: docResearcherUserPrompt,
    agent: { surface: 'inline' },
    webResearchHint:
      'gather current prior art, standards and references for the document being written',
    presentation: {
      label: 'Doc Researcher',
      icon: 'i-lucide-book-marked',
      color: '#38bdf8',
      description:
        'Investigates the topic, prior art and linked context, producing a research brief before a document is drafted.',
      category: 'docs',
    },
  },
  {
    kind: DOC_OUTLINER_KIND,
    systemPrompt: DOC_OUTLINER_SYSTEM_PROMPT,
    userPrompt: docOutlinerUserPrompt,
    agent: { surface: 'inline' },
    presentation: {
      label: 'Doc Outliner',
      icon: 'i-lucide-list-tree',
      color: '#818cf8',
      description:
        'Turns the brief and research into a kind-appropriate document outline for human review before drafting.',
      category: 'docs',
    },
  },
  {
    kind: DOC_WRITER_KIND,
    systemPrompt: DOC_WRITER_SYSTEM_PROMPT,
    userPrompt: docWriterUserPrompt,
    // Container-coding with a `work` clone ⇒ the generic coding harness branches off base,
    // writes the Markdown, pushes the work branch and opens the PR (coder-like). Its companion
    // `doc-reviewer` loops it back for rework below threshold.
    agent: { surface: 'container-coding', clone: { branch: 'work' } },
    presentation: {
      label: 'Doc Writer',
      icon: 'i-lucide-file-pen-line',
      color: '#818cf8',
      description:
        'Writes the document as in-repo Markdown following the approved outline, and opens a pull request.',
      category: 'docs',
    },
  },
  {
    kind: DOC_FINALIZER_KIND,
    systemPrompt: DOC_FINALIZER_SYSTEM_PROMPT,
    userPrompt: docFinalizerUserPrompt,
    // Container-coding with a `pr` clone ⇒ polish in place on the document PR branch and push
    // back (no new PR), fixer-like. The human gate's revision feedback is threaded in by
    // `withRevision` (catalog.ts), so the editor addresses it on this pass.
    agent: { surface: 'container-coding', clone: { branch: 'pr' } },
    presentation: {
      label: 'Doc Finalizer',
      icon: 'i-lucide-file-check-2',
      color: '#818cf8',
      description:
        'Final editorial pass over the drafted document — clarity, consistency, formatting and reviewer feedback.',
      category: 'docs',
    },
  },
]

/**
 * Register the document-authoring kinds. Idempotent (the registry replaces by kind), so calling
 * it explicitly and importing this module for its side effect are safe to combine.
 */
export function registerDocumentAgents(): void {
  registerAgentKinds(DOCUMENT_AGENT_KINDS)
}

// Side-effect registration: importing `@cat-factory/agents` registers these first-class kinds.
registerDocumentAgents()
