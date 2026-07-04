import type { AgentRunContext } from '@cat-factory/kernel'
import { isSafeDocPath } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { systemPromptFor, userPromptFor } from '../catalog.js'
import {
  companionFor,
  companionTargets,
  isCompanionKind,
  isContainerBackedCompanion,
} from './companions.js'
import {
  DOC_FINALIZER_KIND,
  DOC_OUTLINER_KIND,
  DOC_RESEARCHER_KIND,
  DOC_REVIEWER_KIND,
  DOC_WRITER_KIND,
} from './document.js'
import { registeredAgentStep, registeredKindRequiresContainer } from './registry.js'
import { DOC_AWARE_TRAIT, hasTrait } from './traits.js'

// Importing the package registers the document kinds as a side effect; ./document is imported
// transitively here, so the registry is populated.

function ctx(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: DOC_WRITER_KIND,
    pipelineName: 'Author a document',
    stepIndex: 0,
    isFinalStep: false,
    block: {
      title: 'Billing Service PRD',
      type: 'service',
      description: 'Define the billing service requirements.',
      taskTypeFields: { docKind: 'prd', audience: 'product stakeholders' },
    },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...overrides,
  }
}

describe('document agent kinds', () => {
  it('registers the inline research/outline kinds and container-coding writer/finalizer', () => {
    expect(registeredAgentStep(DOC_RESEARCHER_KIND)?.surface).toBe('inline')
    expect(registeredAgentStep(DOC_OUTLINER_KIND)?.surface).toBe('inline')
    expect(registeredAgentStep(DOC_WRITER_KIND)?.surface).toBe('container-coding')
    expect(registeredAgentStep(DOC_FINALIZER_KIND)?.surface).toBe('container-coding')
    // The writer branches off base + opens a PR (coder-like); the finalizer polishes the PR.
    expect(registeredAgentStep(DOC_WRITER_KIND)?.clone?.branch).toBe('work')
    expect(registeredAgentStep(DOC_FINALIZER_KIND)?.clone?.branch).toBe('pr')
    // Container kinds route to the container executor.
    expect(registeredKindRequiresContainer(DOC_WRITER_KIND)).toBe(true)
    expect(registeredKindRequiresContainer(DOC_FINALIZER_KIND)).toBe(true)
    expect(registeredKindRequiresContainer(DOC_RESEARCHER_KIND)).toBe(false)
  })

  it('marks every document-authoring kind (incl. the reviewer) doc-aware for style folding', () => {
    // The `doc-aware` trait is what makes the engine fold the task's writing-style fragments
    // (anti-LLM-isms, concise & actionable) into these kinds' prompts — the doc analogue of
    // `code-aware`. The reviewer carries it too, so the same bodies become its review criteria.
    for (const kind of [
      DOC_RESEARCHER_KIND,
      DOC_OUTLINER_KIND,
      DOC_WRITER_KIND,
      DOC_FINALIZER_KIND,
      DOC_REVIEWER_KIND,
    ]) {
      expect(hasTrait(kind, DOC_AWARE_TRAIT)).toBe(true)
    }
  })

  it('makes doc-reviewer a companion of doc-writer', () => {
    expect(isCompanionKind(DOC_REVIEWER_KIND)).toBe(true)
    expect(companionTargets(DOC_REVIEWER_KIND)).toContain(DOC_WRITER_KIND)
    expect(companionFor(DOC_REVIEWER_KIND)?.targets).toEqual([DOC_WRITER_KIND])
  })

  it('runs doc-reviewer in a container so it reads the actual document, not a summary', () => {
    // The writer's deliverable is the committed Markdown, so its reviewer must clone the PR
    // branch and read it — an inline review of the writer's summary reply is worthless.
    expect(isContainerBackedCompanion(DOC_REVIEWER_KIND)).toBe(true)
    // The system prompt tells it to read the checkout rather than judge from the reply.
    const prompt = systemPromptFor(DOC_REVIEWER_KIND)
    expect(prompt).toContain('read-only checkout')
    expect(prompt).toContain('Do NOT judge from the')
    // It still emits the structured verdict JSON the engine parses.
    expect(prompt).toContain('"rating"')
  })

  it("specialises the writer's prompt on the task's docKind and target path", () => {
    const prompt = userPromptFor(ctx(), { materialized: true })
    // The kind-specific structure guidance + the default target path are woven in.
    expect(prompt).toContain('Document kind: prd')
    expect(prompt).toContain('docs/prd/billing-service-prd.md')
    expect(prompt).toContain('product stakeholders')
  })

  it("weaves the docKind template's required sections into the outliner prompt", () => {
    const prompt = userPromptFor(ctx({ agentKind: DOC_OUTLINER_KIND }), {})
    // The PRD template's required sections must be named as things the outline has to cover.
    expect(prompt).toContain('MUST cover these required sections')
    expect(prompt).toContain('Acceptance Criteria')
    expect(prompt).toContain('Success Metrics')
  })

  it('embeds the docKind template skeleton in the writer prompt', () => {
    const prompt = userPromptFor(ctx(), { materialized: true })
    expect(prompt).toContain('template skeleton')
    // The skeleton is titled from the block and carries the required section headings.
    expect(prompt).toContain('# Billing Service PRD')
    expect(prompt).toContain('## Problem & Goals')
  })

  it('does not repeat the section list in the brief when fuller template guidance follows', () => {
    // The writer/outliner already receive the skeleton / outline guidance, so the brief names
    // just the kind ("produce a product requirements document.") rather than re-listing every
    // section ("… document: Overview, Problem & Goals, …"). The researcher, which gets ONLY the
    // brief, keeps the full section list.
    const writer = userPromptFor(ctx(), { materialized: true })
    const outliner = userPromptFor(ctx({ agentKind: DOC_OUTLINER_KIND }), {})
    const researcher = userPromptFor(ctx({ agentKind: DOC_RESEARCHER_KIND }), {})
    expect(writer).toContain('produce a product requirements document.')
    expect(writer).not.toContain('a product requirements document:')
    expect(outliner).not.toContain('a product requirements document:')
    // The researcher's brief still spells out the sections (it has no other structure guidance).
    expect(researcher).toContain('a product requirements document: ')
    expect(researcher).toContain('Acceptance Criteria')
  })

  it('honours an explicit targetPath override', () => {
    const prompt = userPromptFor(
      ctx({
        block: {
          ...ctx().block,
          taskTypeFields: { docKind: 'rfc', targetPath: 'docs/rfcs/0001-foo.md' },
        },
      }),
      { materialized: true },
    )
    expect(prompt).toContain('docs/rfcs/0001-foo.md')
    expect(prompt).toContain('Document kind: rfc')
  })

  it("folds the task's kind-specific fields into the brief as required section content", () => {
    const prompt = userPromptFor(
      ctx({
        block: {
          ...ctx().block,
          taskTypeFields: {
            docKind: 'prd',
            targetUsers: 'self-serve SMB admins',
            successMetrics: 'activation rate > 40%',
          },
        },
      }),
      { materialized: true },
    )
    // The PRD-specific fields are labelled and marked as required content for the writer.
    expect(prompt).toContain('Author-provided prd specifics')
    expect(prompt).toContain('Target users: self-serve SMB admins')
    expect(prompt).toContain('Success metrics: activation rate > 40%')
  })

  it('omits a kind-specific field the author left blank, and the section when none are set', () => {
    // Only the filled field appears — a blank one is not emitted as an empty bullet.
    const partial = userPromptFor(
      ctx({
        block: {
          ...ctx().block,
          taskTypeFields: { docKind: 'adr', consideredOptions: 'A vs B vs C' },
        },
      }),
      { materialized: true },
    )
    expect(partial).toContain('Considered options: A vs B vs C')
    expect(partial).not.toContain('Decision drivers:')
    // No specifics set ⇒ no "Author-provided … specifics" line at all.
    const none = userPromptFor(
      ctx({ block: { ...ctx().block, taskTypeFields: { docKind: 'adr' } } }),
      { materialized: true },
    )
    expect(none).not.toContain('specifics')
  })

  it('the container-coding writer is NOT told to put its answer in the reply (it commits)', () => {
    // FINAL_ANSWER_IN_REPLY is for inline/explore deliverable-is-the-reply kinds; the writer's
    // product is a pushed commit, so it must not get that directive.
    expect(systemPromptFor(DOC_WRITER_KIND)).not.toContain(
      'Your deliverable is the text of your FINAL reply',
    )
    // The inline outliner DOES (its prose reply is the deliverable).
    expect(systemPromptFor(DOC_OUTLINER_KIND)).toContain(
      'Your deliverable is the text of your FINAL reply',
    )
  })

  it('constrains a document targetPath to a safe relative Markdown path', () => {
    // Accept normal relative .md paths.
    expect(isSafeDocPath('docs/rfcs/0001-foo.md')).toBe(true)
    expect(isSafeDocPath('README.md')).toBe(true)
    // Reject traversal, absolute, backslash, non-.md and empty — these could escape the repo
    // or clobber non-document files when used verbatim as the writer's commit path.
    expect(isSafeDocPath('../../package.json')).toBe(false)
    expect(isSafeDocPath('../secrets.md')).toBe(false)
    expect(isSafeDocPath('/etc/passwd.md')).toBe(false)
    expect(isSafeDocPath('docs\\win.md')).toBe(false)
    expect(isSafeDocPath('docs/notes.txt')).toBe(false)
    expect(isSafeDocPath('   ')).toBe(false)
  })
})
