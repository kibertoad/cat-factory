import type { SandboxFixture } from '@cat-factory/contracts'
import { blockTypeSchema } from '@cat-factory/contracts'
import type {
  AgentRunContext,
  BlockType,
  InjectedContextFile,
  OwnServiceContext,
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

/** Everything a builder needs about the cell whose input it is rendering. */
interface FixtureCell {
  payload: Record<string, unknown>
  /** The fixture's name, for the refusals below. */
  fixtureName: string
  /**
   * The CATALOG entry the cell runs under. The agent kind comes from here and nowhere else: the
   * system prompt is composed from `meta.agentKind`, so reading the kind off the payload instead
   * would let a hand-authored fixture compose one kind's user prompt under another's system
   * prompt: the same "silently grade a different task" the missing generic fallback rules out.
   */
  meta: SandboxAgentKindMeta
  /**
   * The evaluation note this cell owes the candidate ({@link NO_CHECKOUT_NOTICE}), or undefined.
   *
   * Each builder PLACES it rather than the caller appending it to the finished string. On the
   * `userPromptFor` path the prompt ends on the kind's `userPromptSuffix` by design (that field
   * exists to be the last thing the agent reads), so an append afterwards buries a reply-shape
   * instruction behind an aside.
   */
  notice: string | undefined
}

/** Builds the user prompt for one agent kind from a fixture's payload. */
type InputBuilder = (cell: FixtureCell) => string

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
  const asAgentContext: InputBuilder = (cell) =>
    userPromptFor(agentRunContext(cell), registry, cell.notice ? { runNotice: cell.notice } : {})
  // The inline ENGINE builders return a plain string with no closing instruction of their own, so
  // appending is the right placement for them; it is still routed through one helper rather than
  // hand-written three times, so a kind that later grows a suffix has one place to change.
  return {
    'requirements-review': (cell) =>
      appendNotice(buildReviewPrompt(requirementsContext(cell)), cell),
    'clarity-review': (cell) => appendNotice(buildClarityPrompt(clarityContext(cell)), cell),
    'requirements-writer': (cell) =>
      appendNotice(
        buildRecommendationPrompt(
          requirementsContext(cell),
          findings(cell),
          grounding(cell.payload),
        ),
        cell,
      ),
    reviewer: asAgentContext,
    'architect-companion': asAgentContext,
    'task-estimator': asAgentContext,
  }
}

function appendNotice(prompt: string, cell: FixtureCell): string {
  return cell.notice ? `${prompt}\n\n${cell.notice}` : prompt
}

/**
 * Render a fixture into the task input for one cell.
 *
 * Throws a {@link ValidationError} naming the fixture when its payload cannot be read as the shape
 * its agent kind consumes. That is deliberate: the old tolerant renderer turned a malformed
 * workspace fixture into an EMPTY prompt, and the cell then ran, the judge was told "(no task input
 * was supplied)", and it graded anyway, producing a real-looking score for a task nobody posed.
 *
 * Because it throws, the run-driver resolves it BEFORE claiming the experiment: a fixture the
 * builder cannot read is a bad request, not a half-run grid.
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
  return build({
    payload: fixture.payload ?? {},
    fixtureName: fixture.name,
    meta,
    notice: statesMissingCheckout(meta) ? NO_CHECKOUT_NOTICE : undefined,
  })
}

// ---- payload coercion -----------------------------------------------------
// A payload is `Record<string, unknown>` on the wire (a workspace may author one by hand), so each
// coercion asserts what its builder cannot work without and defaults the rest. The BUILTIN payloads
// are additionally pinned against the real context types by `sandbox-fixture-payloads.test.ts`.

/**
 * Narrow a payload's `block.type` through the picklist that OWNS the vocabulary rather than a copy
 * of its members. A hand list is silently partial the day a block type is added: the coercion keeps
 * compiling, downgrades the new type to `service`, and the fixture's prompt then names a different
 * kind of thing than the fixture describes.
 */
function isBlockType(value: unknown): value is BlockType {
  return (blockTypeSchema.options as readonly string[]).includes(value as string)
}

/** The `{ title, type, description }` every context shape starts from. */
function block(cell: FixtureCell): { title: string; type: BlockType; description: string } {
  const raw = asRecord(cell.payload.block)
  const title = asString(raw.title)
  if (!title) {
    throw new ValidationError(
      `Fixture "${cell.fixtureName}" has no \`block.title\`; there is nothing for the agent to work on.`,
      { reason: 'sandbox_fixture_payload_invalid' },
    )
  }
  return {
    title,
    type: isBlockType(raw.type) ? raw.type : 'service',
    description: asString(raw.description),
  }
}

function requirementsContext(cell: FixtureCell): RequirementsContext {
  const payload = cell.payload
  // `service` rides through as authored: absent means the fixture deliberately does not identify
  // the product, which `buildReviewPrompt` STATES ("do not pick one") rather than omitting. A
  // fixture that supplies one is exercising the opposite, identified path.
  return {
    block: block(cell),
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

function clarityContext(cell: FixtureCell): ClarityContext {
  const payload = cell.payload
  return {
    block: block(cell),
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
function findings(cell: FixtureCell): RequirementReviewItem[] {
  const items = asArray(cell.payload.findings).map((item, index) => {
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
      `Fixture "${cell.fixtureName}" declares no \`findings\`; the requirement writer answers findings, so there is nothing to recommend.`,
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
function agentRunContext(cell: FixtureCell): AgentRunContext {
  const payload = cell.payload
  const resolved = asRecord(payload.resolvedDecision)
  return {
    // From the CATALOG entry, never the payload: this context composes the USER prompt while
    // `meta.agentKind` composes the SYSTEM prompt, and a payload that named a different kind (or
    // named none, and defaulted) would pair one kind's task framing with another's instructions.
    agentKind: cell.meta.agentKind,
    pipelineName: asString(payload.pipelineName) || 'sandbox',
    stepIndex: typeof payload.stepIndex === 'number' ? payload.stepIndex : 0,
    isFinalStep: payload.isFinalStep !== false,
    block: {
      ...block(cell),
      ...optional('estimate', payload.estimate as AgentRunContext['block']['estimate']),
    },
    ownService: ownService(payload),
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

/**
 * Which system the fixture's work belongs to, ALWAYS answered.
 *
 * Production's `AgentContextBuilder` populates `ownService` on every dispatch, and
 * `ownServiceSection` is the one section that renders when the value says "no service", because a
 * short task title names no software, so a silent omission reads exactly like a task whose product
 * is obvious, and a model asked for concrete output then supplies one. Leaving the field undefined
 * here would have graded these three kinds on a prompt production never sends, and penalised a
 * candidate for inventing a product the harness gave it no way to know.
 *
 * A fixture that identifies one authors `ownService` as the real `OwnServiceContext` (the payload
 * IS the context shape); one that does not gets the honest `not-under-a-service`, which is what
 * production sends for a task sitting outside every service frame.
 */
function ownService(payload: Record<string, unknown>): OwnServiceContext {
  const own = payload.ownService as OwnServiceContext | undefined
  if (own && typeof own === 'object' && typeof own.stated === 'boolean') return own
  return { stated: false, reason: 'not-under-a-service' }
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
