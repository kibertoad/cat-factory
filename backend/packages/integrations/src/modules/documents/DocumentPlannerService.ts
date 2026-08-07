import { generateText } from 'ai'
import type { ModelProvider, ModelProviderResolver, ModelRef } from '@cat-factory/kernel'
import type { DocumentRecord } from '@cat-factory/kernel'
import type { DocumentBoardPlan } from '@cat-factory/kernel'
import { catFactoryObservability, extractJson } from '@cat-factory/kernel'
import { isDesignSource } from '@cat-factory/contracts'
import {
  coercePlan,
  coerceTargetedPlan,
  markdownToText,
  planFromHeadings,
  type PlanTarget,
} from './documents.logic.js'

// DocumentPlannerService: turns an imported document into a proposed board
// structure (frames → modules → tasks). When a model is configured it asks an
// LLM, via the provider-agnostic ModelProvider port, to extract the structure;
// otherwise — or if the LLM response can't be parsed — it falls back to the
// deterministic heading parser. The LLM is therefore optional: import, link and
// spawn all work without it. Source-agnostic, because providers normalize bodies
// to Markdown before they reach here.
//
// Two axes decide which prompt runs, and they are independent:
//
//  - TARGET. Without a {@link PlanTarget} the question is "what architecture does this document
//    describe"; with one it is "what work does it imply inside this service that already exists".
//    They are different prompts rather than one prompt with a hint, because the answers have
//    different shapes: the first proposes frames, the second may not propose any.
//  - ORIGIN. A design document describes screens, not an architecture, so asking the
//    architecture question of one produces a service per Figma page. `isDesignSource` decides,
//    read from CONTRACTS rather than from a provider, for the same reason the design-guidance
//    fragment reads it there: this path holds a stored row and no provider.

const MAX_BODY_CHARS = 6000

export interface DocumentPlannerServiceDependencies {
  /**
   * Resolve a {@link ModelProvider} for a workspace's credential scope (DB-backed key
   * pool). Preferred over the static `modelProvider`; the facade supplies it.
   */
  modelProviderResolver?: ModelProviderResolver
  /** Static planner model provider (e.g. a fake in tests). Used when no resolver is set. */
  modelProvider?: ModelProvider
  /** Which model to use for planning (the agents' default model ref). */
  modelRef?: ModelRef
}

const SYSTEM_PROMPT =
  'You are a software architect. You convert a product/requirements/RFC document into a ' +
  'concrete software-architecture board: top-level frames (services), modules within them, ' +
  'and tasks (units of work). Respond with ONLY a JSON object, no prose, no code fences.'

/**
 * The targeted system prompt. It states the ONE thing the board-wide prompt must not be allowed
 * to carry over: the service exists, so proposing services is out of scope. Without that said
 * outright, a model handed a document and a frame name routinely answers with an architecture
 * whose first frame happens to be the target.
 */
const TARGETED_SYSTEM_PROMPT =
  'You are a technical lead planning work inside a service that ALREADY EXISTS. You never ' +
  'propose new services or repositories; you propose modules (groupings) and tasks (units of ' +
  'work) to add to the service you are given. Respond with ONLY a JSON object, no prose, no ' +
  'code fences.'

/**
 * What a DESIGN document is, said to the model in the terms it must plan in.
 *
 * Folded into both prompts rather than replacing them, because the change a design origin makes
 * is to the SUBJECT, not to the shape of the answer: the document describes screens and flows,
 * and one task per screen/flow is the decomposition an implementer can act on. The alternative,
 * a whole third prompt pair, would duplicate the JSON contract in four places.
 */
const DESIGN_GUIDANCE = [
  'This document is a DESIGN (frames, components and tokens exported from a design tool), not a',
  'written specification. Plan the work it implies to BUILD it: one task per screen, state or',
  'flow it shows, named after the frame it comes from so an implementer can find it in the file.',
  'Do not propose tasks for design work itself, and do not invent backend services the design',
  'does not evidence — a design describes an interface, and what sits behind it is not in it.',
].join(' ')

function documentText(record: DocumentRecord): string {
  return markdownToText(record.body).slice(0, MAX_BODY_CHARS)
}

function buildUserPrompt(record: DocumentRecord): string {
  return [
    `Document title: ${record.title}`,
    ...(isDesignSource(record.source) ? ['', DESIGN_GUIDANCE] : []),
    '',
    'Document content:',
    documentText(record),
    '',
    'Produce a JSON object of this exact shape:',
    '{',
    '  "frames": [',
    '    {',
    '      "type": "service|api|frontend|database|queue|integration|external",',
    '      "title": "string",',
    '      "description": "string (optional)",',
    '      "modules": [ { "name": "string", "tasks": [ { "title": "string", "description": "string (optional)" } ] } ],',
    '      "tasks": [ { "title": "string", "description": "string (optional)" } ]',
    '    }',
    '  ]',
    '}',
    '',
    'Group related work into modules; keep titles short and imperative. Output JSON only.',
  ].join('\n')
}

/**
 * The target-aware prompt.
 *
 * It names the modules the frame already holds so the plan ADDS to them: a model that cannot see
 * the board proposes "Checkout" beside the "Checkout" that is already there, and the spawn
 * happily creates the duplicate.
 */
function buildTargetedUserPrompt(record: DocumentRecord, target: PlanTarget): string {
  return [
    `Existing service: ${target.title} (type: ${target.type})`,
    target.existingModules.length > 0
      ? `Modules it already has: ${target.existingModules.join(', ')}. Reuse these names for work that belongs in them rather than proposing a second module with the same meaning.`
      : 'It has no modules yet.',
    '',
    `Document title: ${record.title}`,
    ...(isDesignSource(record.source) ? ['', DESIGN_GUIDANCE] : []),
    '',
    'Document content:',
    documentText(record),
    '',
    'Produce a JSON object of this exact shape:',
    '{',
    '  "modules": [ { "name": "string", "tasks": [ { "title": "string", "description": "string (optional)" } ] } ],',
    '  "tasks": [ { "title": "string", "description": "string (optional)" } ]',
    '}',
    '',
    'Modules group related tasks; `tasks` holds work that belongs to no module. Keep titles',
    'short and imperative. Output JSON only.',
  ].join('\n')
}

export class DocumentPlannerService {
  constructor(private readonly deps: DocumentPlannerServiceDependencies) {}

  /** Whether LLM planning is available (a model provider/resolver + ref are configured). */
  get llmEnabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  /**
   * Propose a board structure for an imported document, either at the board root or inside an
   * existing service frame.
   *
   * The fallback is always the same SHAPE as the request: a targeted plan that could not be
   * produced degrades to the targeted heading parser, never to a board-wide plan, because the
   * caller is about to spawn into one frame and a whole architecture flattened into it is the
   * discarding the target-aware path exists to prevent.
   */
  async plan(record: DocumentRecord, target?: PlanTarget): Promise<DocumentBoardPlan> {
    const fallback = () =>
      planFromHeadings(record.source, record.externalId, record.title, record.body, target)
    if (!this.deps.modelRef || (!this.deps.modelProviderResolver && !this.deps.modelProvider)) {
      return fallback()
    }

    try {
      const provider = this.deps.modelProviderResolver
        ? await this.deps.modelProviderResolver.forScope({ workspaceId: record.workspaceId })
        : this.deps.modelProvider!
      const model = provider.resolve(this.deps.modelRef)
      const { text } = await generateText({
        model,
        system: target ? TARGETED_SYSTEM_PROMPT : SYSTEM_PROMPT,
        prompt: target ? buildTargetedUserPrompt(record, target) : buildUserPrompt(record),
        temperature: 0.2,
        // Headroom for a reasoning model's `<think>` before the JSON plan — a
        // tight cap truncates the plan mid-output (finish_reason: length).
        maxOutputTokens: 5000,
        // Label the call for the trace sink (a no-op when no instrumented provider
        // is wired). Not run-scoped, so it surfaces as its own standalone trace.
        providerOptions: catFactoryObservability({
          agentKind: 'document-planner',
          workspaceId: record.workspaceId,
        }),
      })
      const parsed = extractJson(text)
      const plan = target
        ? coerceTargetedPlan(record.source, record.externalId, parsed, target)
        : coercePlan(record.source, record.externalId, parsed)
      return plan ?? fallback()
    } catch {
      // silent-catch-ok: any provider/parse failure degrades to the deterministic plan, which is
      // the whole reason the heading parser is kept; the plan is a PREVIEW the user approves, so
      // a degraded one is visible to them before anything is written.
      return fallback()
    }
  }
}
