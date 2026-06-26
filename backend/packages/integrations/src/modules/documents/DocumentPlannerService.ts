import { generateText } from 'ai'
import type { ModelProvider, ModelProviderResolver, ModelRef } from '@cat-factory/kernel'
import type { DocumentRecord } from '@cat-factory/kernel'
import type { DocumentBoardPlan } from '@cat-factory/kernel'
import { catFactoryObservability, extractJson } from '@cat-factory/kernel'
import { coercePlan, markdownToText, planFromHeadings } from './documents.logic.js'

// DocumentPlannerService: turns an imported document into a proposed board
// structure (frames → modules → tasks). When a model is configured it asks an
// LLM, via the provider-agnostic ModelProvider port, to extract the structure;
// otherwise — or if the LLM response can't be parsed — it falls back to the
// deterministic heading parser. The LLM is therefore optional: import, link and
// spawn all work without it. Source-agnostic, because providers normalize bodies
// to Markdown before they reach here.

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

function buildUserPrompt(title: string, body: string): string {
  const text = markdownToText(body).slice(0, MAX_BODY_CHARS)
  return [
    `Document title: ${title}`,
    '',
    'Document content:',
    text,
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

export class DocumentPlannerService {
  constructor(private readonly deps: DocumentPlannerServiceDependencies) {}

  /** Whether LLM planning is available (a model provider/resolver + ref are configured). */
  get llmEnabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  /** Propose a board structure for an imported document. */
  async plan(record: DocumentRecord): Promise<DocumentBoardPlan> {
    const fallback = () =>
      planFromHeadings(record.source, record.externalId, record.title, record.body)
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
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(record.title, record.body),
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
      const plan = coercePlan(record.source, record.externalId, extractJson(text))
      return plan ?? fallback()
    } catch {
      // Any provider/parse failure degrades gracefully to the deterministic plan.
      return fallback()
    }
  }
}
