import type { SandboxFixture } from '@cat-factory/contracts'
import type {
  AgentRunContext,
  BlockType,
  InjectedContextFile,
  RequirementReviewItem,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { type AgentKindRegistry, userPromptFor } from '@cat-factory/agents'
import { type SandboxAgentKindMeta, statesMissingCheckout } from '@cat-factory/sandbox'
import { buildClarityPrompt, type ClarityContext } from '../clarity/clarity.logic.js'
import {
  buildRecommendationPrompt,
  buildReviewPrompt,
  type RecommendationGrounding,
  type RequirementsContext,
} from '../requirements/requirements.logic.js'

// The TASK INPUT half of a Sandbox cell: turning a fixture's stored payload into the user prompt
// the candidate reasons over and the judge grades against.
//
// The rule this module exists to hold: a cell must send the prompt PRODUCTION sends. The system half
// already did (`composedSystemPromptFor`, the same composition a workspace override rides), but the
// user half was a hand-rolled approximation that rendered a title, a description and any prior
// outputs. For `requirements-review` that meant the candidate was never given the JSON output
// contract, the product-scope test or the `autoAnswerable` rule at all (the three things the
// shipped prompt is mostly ABOUT), and was then graded on a rubric that scores exactly those. So
// every kind resolves its input through the SAME pure builder its production caller uses, and there
// is deliberately no generic fallback: an unknown kind is refused at launch, so a fallback could
// only ever mean "silently grade a different task".

/** Builds the user prompt for one agent kind from a fixture's payload. */
type InputBuilder = (payload: Record<string, unknown>, fixtureName: string) => string

/**
 * What the candidate is TOLD when the Sandbox runs a kind production dispatches into a container.
 *
 * Its composed system prompt was written for an agent holding a real clone and instructs it to diff
 * the branch and read the changed files; here there is neither a checkout nor a tool loop. Left
 * unsaid, the candidate spends its answer apologising for files it could not open and the grade
 * measures the harness rather than the prompt, which is the same defect as silently dropping a
 * capability the prompt promised (see the "degrade loudly" rule).
 */
const NO_CHECKOUT_NOTICE = [
  'EVALUATION NOTE: this run has NO repository checkout and no tools. Your instructions above',
  'describe a run in which you would clone the branch and read the files yourself; here the work',
  'under review is reproduced in full in the material above, and that material is all there is.',
  'Review what you were given. Where a judgement genuinely needs code you were not shown, say so',
  'explicitly instead of reporting on files you could not read.',
].join('\n')

/**
 * The per-kind builders, each delegating to the pure prompt builder its production caller uses:
 * `IterativeReviewService` for the requirements/clarity reviewers, `RequirementReviewService` for
 * the Writer, and the generic `userPromptFor` for every kind the engine dispatches as an ordinary
 * agent step (the companions and the estimator).
 *
 * Keyed by AGENT KIND, not fixture kind: the fixture kind says what shape the payload is, the agent
 * kind decides what prompt that shape becomes.
 */
function inputBuilders(registry: AgentKindRegistry): Record<string, InputBuilder> {
  const asAgentContext: InputBuilder = (payload, fixtureName) =>
    userPromptFor(agentRunContext(payload, fixtureName), registry)
  return {
    'requirements-review': (payload, name) => buildReviewPrompt(requirementsContext(payload, name)),
    'clarity-review': (payload, name) => buildClarityPrompt(clarityContext(payload, name)),
    'requirements-writer': (payload, name) => {
      const context = requirementsContext(payload, name)
      return buildRecommendationPrompt(context, findings(payload, name), grounding(payload))
    },
    reviewer: asAgentContext,
    'architect-companion': asAgentContext,
    'task-estimator': asAgentContext,
  }
}

/**
 * Render a fixture into the task input for one cell.
 *
 * Throws a {@link ValidationError} naming the fixture when its payload cannot be read as the shape
 * its agent kind consumes. That is deliberate: the old tolerant renderer turned a malformed
 * workspace fixture into an EMPTY prompt, and the cell then ran, the judge was told "(no task input
 * was supplied)", and it graded anyway, producing a real-looking score for a task nobody posed.
 */
export function renderFixtureInput(
  fixture: SandboxFixture,
  meta: SandboxAgentKindMeta,
  registry: AgentKindRegistry,
): string {
  const build = inputBuilders(registry)[meta.agentKind]
  if (!build) {
    throw new ValidationError(
      `The Sandbox has no task-input builder for "${meta.agentKind}"; it cannot be run as a cell.`,
      { reason: 'sandbox_input_unsupported' },
    )
  }
  const text = build(fixture.payload ?? {}, fixture.name)
  return statesMissingCheckout(meta) ? `${text}\n\n${NO_CHECKOUT_NOTICE}` : text
}

// ---- payload coercion -----------------------------------------------------
// A payload is `Record<string, unknown>` on the wire (a workspace may author one by hand), so each
// coercion asserts what its builder cannot work without and defaults the rest. The BUILTIN payloads
// are additionally pinned against the real context types by `sandbox-fixture-payloads.test.ts`.

const BLOCK_TYPES: readonly BlockType[] = [
  'frontend',
  'service',
  'api',
  'database',
  'queue',
  'integration',
  'external',
  'environment',
]

/** The `{ title, type, description }` every context shape starts from. */
function block(
  payload: Record<string, unknown>,
  fixtureName: string,
): { title: string; type: BlockType; description: string } {
  const raw = asRecord(payload.block)
  const title = asString(raw.title)
  if (!title) {
    throw new ValidationError(
      `Fixture "${fixtureName}" has no \`block.title\`; there is nothing for the agent to work on.`,
      { reason: 'sandbox_fixture_payload_invalid' },
    )
  }
  const type = raw.type
  return {
    title,
    type: BLOCK_TYPES.includes(type as BlockType) ? (type as BlockType) : 'service',
    description: asString(raw.description),
  }
}

function requirementsContext(
  payload: Record<string, unknown>,
  fixtureName: string,
): RequirementsContext {
  // `service` rides through as authored: absent means the fixture deliberately does not identify
  // the product, which `buildReviewPrompt` STATES ("do not pick one") rather than omitting. A
  // fixture that supplies one is exercising the opposite, identified path.
  return {
    block: block(payload, fixtureName),
    docs: asArray(payload.docs).map((doc) => {
      const d = asRecord(doc)
      return {
        title: asString(d.title) || 'Document',
        url: asString(d.url),
        excerpt: asString(d.excerpt) || asString(d.body) || asString(d.content),
      }
    }),
    tasks: asArray(payload.tasks).map((task) => {
      const t = asRecord(task)
      return {
        key: asString(t.key) || 'ISSUE',
        title: asString(t.title) || 'Issue',
        status: asString(t.status) || 'open',
        type: asString(t.type) || 'task',
        description: asString(t.description) || asString(t.body),
      }
    }),
    ...optional('service', payload.service as RequirementsContext['service']),
    ...optionalString('specIntent', payload.specIntent),
    ...optionalString('refinedDirection', payload.refinedDirection),
    ...optionalString('incorporatedDoc', payload.incorporatedDoc),
  }
}

function clarityContext(payload: Record<string, unknown>, fixtureName: string): ClarityContext {
  return {
    block: block(payload, fixtureName),
    ...optional('service', payload.service as ClarityContext['service']),
    ...optionalString('investigation', payload.investigation),
    ...optionalString('clarifiedDoc', payload.clarifiedDoc),
  }
}

/**
 * The findings the Requirement Writer must answer. Required and non-empty: the Writer's whole
 * contract is one recommendation per finding id, so a fixture with none poses no task and its
 * `coverage` dimension would have nothing to score.
 */
function findings(payload: Record<string, unknown>, fixtureName: string): RequirementReviewItem[] {
  const items = asArray(payload.findings).map((item, index) => {
    const f = asRecord(item)
    return {
      id: asString(f.id) || `finding-${index + 1}`,
      category: (asString(f.category) || 'gap') as RequirementReviewItem['category'],
      severity: (asString(f.severity) || 'medium') as RequirementReviewItem['severity'],
      title: asString(f.title),
      detail: asString(f.detail),
      status: (asString(f.status) || 'open') as RequirementReviewItem['status'],
      reply: null,
      ...(typeof f.autoAnswerable === 'boolean' ? { autoAnswerable: f.autoAnswerable } : {}),
      createdAt: 0,
      updatedAt: 0,
    } satisfies RequirementReviewItem
  })
  if (items.length === 0) {
    throw new ValidationError(
      `Fixture "${fixtureName}" declares no \`findings\`; the requirement writer answers findings, so there is nothing to recommend.`,
      { reason: 'sandbox_fixture_payload_invalid' },
    )
  }
  return items
}

/**
 * The grounding material, in the Writer's own precedence order. Every leg is optional and an EMPTY
 * one is meaningful rather than missing: a fixture with no standards and no spec excerpts is the one
 * that tests whether the Writer reports `general-practice` honestly instead of citing a source it
 * was never given.
 */
function grounding(payload: Record<string, unknown>): RecommendationGrounding {
  const raw = asRecord(payload.grounding)
  return {
    fragments: asArray(raw.fragments).map((fragment) => {
      const f = asRecord(fragment)
      return {
        id: asString(f.id),
        title: asString(f.title),
        body: asString(f.body),
      }
    }),
    specExcerpts: asArray(raw.specExcerpts).map((excerpt) => asString(excerpt)),
    webResults: asArray(raw.webResults).map((result) => {
      const w = asRecord(result)
      return { title: asString(w.title), url: asString(w.url), content: asString(w.content) }
    }),
  }
}

/**
 * Build the run context for a kind the engine dispatches as an ordinary agent step, so
 * `userPromptFor` composes the same prompt it would in a real run.
 *
 * `injectedContextFiles` is the field that carries a repo-scale change into an inline cell: it is
 * the production seam for a caller with no filesystem (`withInjectedContext` folds the bodies in and
 * states its own budget), which is why a multi-file fixture uses it rather than pasting the diff
 * into a prior output.
 */
function agentRunContext(payload: Record<string, unknown>, fixtureName: string): AgentRunContext {
  const resolved = asRecord(payload.resolvedDecision)
  return {
    agentKind: asString(payload.agentKind) || 'reviewer',
    pipelineName: asString(payload.pipelineName) || 'sandbox',
    stepIndex: typeof payload.stepIndex === 'number' ? payload.stepIndex : 0,
    isFinalStep: payload.isFinalStep !== false,
    block: {
      ...block(payload, fixtureName),
      ...optional('estimate', payload.estimate as AgentRunContext['block']['estimate']),
    },
    priorOutputs: asArray(payload.priorOutputs).map((prior) => {
      const p = asRecord(prior)
      return { agentKind: asString(p.agentKind) || 'coder', output: asString(p.output) }
    }),
    decisions: asArray(payload.decisions).map((decision) => {
      const d = asRecord(decision)
      return { question: asString(d.question), chosen: asString(d.chosen) }
    }),
    resolvedDecision:
      asString(resolved.question) && asString(resolved.chosen)
        ? { question: asString(resolved.question), chosen: asString(resolved.chosen) }
        : null,
    ...optional('injectedContextFiles', contextFiles(payload.injectedContextFiles)),
  }
}

/** The injected context files, or undefined when the fixture declares none. */
function contextFiles(value: unknown): InjectedContextFile[] | undefined {
  const files = asArray(value).map((file) => {
    const f = asRecord(file)
    return { path: asString(f.path), content: asString(f.content) }
  })
  return files.length > 0 ? files : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Spread an optional field only when it has a value, so the context stays sparse. */
function optional<K extends string, T>(key: K, value: T | undefined): Record<K, T> | object {
  return value === undefined || value === null ? {} : ({ [key]: value } as Record<K, T>)
}

function optionalString<K extends string>(key: K, value: unknown): Record<K, string> | object {
  const text = asString(value).trim()
  return text ? ({ [key]: text } as Record<K, string>) : {}
}
