import { generateText } from 'ai'
import type { ModelProvider, ModelRef } from '../../ports/model-provider'
import type { ConfluenceDocumentRecord } from '../../ports/confluence-repositories'
import type { ConfluenceBoardPlan } from '../../domain/types'
import { coercePlan, htmlToText, planFromHeadings } from './confluence.logic'

// ConfluencePlannerService: turns an imported document into a proposed board
// structure (frames → modules → tasks). When a model is configured it asks an
// LLM, via the provider-agnostic ModelProvider port, to extract the structure;
// otherwise — or if the LLM response can't be parsed — it falls back to the
// deterministic heading parser. The LLM is therefore optional within the
// Confluence module: import, link and spawn all work without it.

const MAX_BODY_CHARS = 6000

export interface ConfluencePlannerServiceDependencies {
  /** Resolves the planner model; absent when no provider is configured. */
  modelProvider?: ModelProvider
  /** Which model to use for planning (the agents' default model ref). */
  modelRef?: ModelRef
}

const SYSTEM_PROMPT =
  'You are a software architect. You convert a product/requirements/RFC document into a ' +
  'concrete software-architecture board: top-level frames (services), modules within them, ' +
  'and tasks (units of work). Respond with ONLY a JSON object, no prose, no code fences.'

function buildUserPrompt(title: string, body: string): string {
  const text = htmlToText(body).slice(0, MAX_BODY_CHARS)
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
    '      "modules": [ { "name": "string", "tasks": [ { "title": "string", "description": "string (optional)", "features": ["string"] } ] } ],',
    '      "tasks": [ { "title": "string", "description": "string (optional)", "features": ["string"] } ]',
    '    }',
    '  ]',
    '}',
    '',
    'Group related work into modules; keep titles short and imperative. Output JSON only.',
  ].join('\n')
}

/** Pull the first JSON object out of a model response (tolerates code fences). */
function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export class ConfluencePlannerService {
  constructor(private readonly deps: ConfluencePlannerServiceDependencies) {}

  /** Whether LLM planning is available (a model provider + ref are configured). */
  get llmEnabled(): boolean {
    return !!this.deps.modelProvider && !!this.deps.modelRef
  }

  /** Propose a board structure for an imported document. */
  async plan(record: ConfluenceDocumentRecord): Promise<ConfluenceBoardPlan> {
    const fallback = () => planFromHeadings(record.pageId, record.title, record.body)
    if (!this.deps.modelProvider || !this.deps.modelRef) return fallback()

    try {
      const model = this.deps.modelProvider.resolve(this.deps.modelRef)
      const { text } = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(record.title, record.body),
        temperature: 0.2,
        maxOutputTokens: 1500,
      })
      const plan = coercePlan(record.pageId, extractJson(text))
      return plan ?? fallback()
    } catch {
      // Any provider/parse failure degrades gracefully to the deterministic plan.
      return fallback()
    }
  }
}
