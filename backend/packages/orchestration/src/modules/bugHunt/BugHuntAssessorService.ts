import { generateText } from 'ai'
import type {
  BugHuntAssessor,
  BugHuntSubject,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
} from '@cat-factory/kernel'
import {
  extractJson,
  inlineModelRef,
  resolveScopedModelProvider,
  ValidationError,
} from '@cat-factory/kernel'
import {
  BUG_HUNT_AGENT_KIND,
  BUG_HUNT_SYSTEM_PROMPT,
  catFactoryObservability,
  renderBugHuntPrompt,
} from '@cat-factory/agents'

// ---------------------------------------------------------------------------
// The default {@link BugHuntAssessor}: the INLINE LLM call behind the bug hunt's ranking.
//
// Structurally the `JudgeService` twin — resolve the model, run `generateText`, return the
// extracted JSON for the caller's parser — with one difference that shapes the whole class: a
// hunt has NO BLOCK. It runs before any task exists, which is the point of the feature, so
// there is no block pin and no per-task model preset to honour; the scope is the workspace and
// the model is its `bug-hunter` default, falling back to the routing default.
//
// Stateless, like the judge, and built from the model dependencies every facade already wires
// — so ranking needs no per-facade wiring, and the conformance harness swaps in a
// deterministic fake through the same `BugHuntAssessor` seam.
//
// `enabled === false` (no provider or no routing default) ⇒ a hunt returns its candidates
// unranked with `analysisStatus: 'unavailable'`, never a failure.
// ---------------------------------------------------------------------------

/** What the inline assessor needs to resolve its model and reach the provider. */
export interface BugHuntAssessorServiceDeps {
  /** Resolve a ModelProvider for a workspace's credential scope (preferred). */
  modelProviderResolver?: ModelProviderResolver
  /** Static provider (e.g. a fake in tests) used when no resolver is set. */
  modelProvider?: ModelProvider
  /** Routing-default model ref. */
  modelRef?: ModelRef
  /** Resolve a model catalog id to a ref (the deployment-aware resolver). */
  resolveBlockModel?: (modelId: string | undefined) => ModelRef | undefined
  /** Keep an ambient-eligible harness ref inline (local mode) instead of degrading it. */
  runsInline?: (ref: ModelRef) => boolean
  /** Resolve the workspace's default model for the `bug-hunter` kind. */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>
  /** Current time, injected so the rendered candidate ages are deterministic under test. */
  now?: () => number
  /** Facade logger; a swallowed ranking failure with no trace is an unowned bug. */
  logger?: { warn(obj: Record<string, unknown>, msg?: string): void }
}

/**
 * Ranking is a judgement over a fixed candidate list, so it must be reproducible for the same
 * board: a shortlist that reorders between two identical hunts is not a recommendation, it's
 * noise. Same reasoning (and same value) as the judge assessment.
 */
const TEMPERATURE = 0

/**
 * Output budget. One verdict is ~60 tokens and a scan is capped at 40 candidates, so this
 * leaves comfortable headroom — a truncated reply is unparseable JSON, which costs the whole
 * ranking rather than its tail.
 */
const MAX_OUTPUT_TOKENS = 6_000

export class BugHuntAssessorService implements BugHuntAssessor {
  constructor(private readonly deps: BugHuntAssessorServiceDeps) {}

  /** Whether a ranking can run (a provider AND a routing default are wired). */
  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  async assess(subject: BugHuntSubject): Promise<{ verdicts: unknown; model: string }> {
    const { modelProvider, ref } = await this.resolveModel(subject.workspaceId)
    const now = this.deps.now?.() ?? Date.now()
    let text: string
    try {
      const result = await generateText({
        model: modelProvider.resolve(ref),
        system: BUG_HUNT_SYSTEM_PROMPT,
        prompt: renderBugHuntPrompt(subject.candidates, now),
        temperature: TEMPERATURE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        providerOptions: catFactoryObservability({
          agentKind: BUG_HUNT_AGENT_KIND,
          workspaceId: subject.workspaceId,
        }),
      })
      text = result.text
    } catch (e) {
      throw this.fail(
        subject,
        ref,
        `generation failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    const verdicts = extractJson(text)
    if (verdicts === null || typeof verdicts !== 'object') {
      // An empty visible reply means the model answered only into its private reasoning
      // channel (seen on some reasoning models); a non-JSON reply means it ignored the
      // contract. Either way there is no ranking, and the hunt must say so rather than
      // present the board's own order as a recommendation.
      throw this.fail(subject, ref, 'the reply contained no JSON ranking')
    }
    return { verdicts, model: `${ref.provider}:${ref.model}` }
  }

  /**
   * Build the error AND log it. The caller deliberately swallows a ranking failure (the scan is
   * still useful), so this is the only place the cause is recorded — without it a revoked key
   * would surface to an operator as nothing but a permanently "unranked" hunt.
   */
  private fail(subject: BugHuntSubject, ref: ModelRef, reason: string): ValidationError {
    const message = `The bug-hunt ranking (${ref.provider}:${ref.model}) ${reason}`
    this.deps.logger?.warn(
      { workspaceId: subject.workspaceId, candidates: subject.candidates.length },
      message,
    )
    return new ValidationError(message)
  }

  private async resolveModel(
    workspaceId: string,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef }> {
    const modelProvider = await resolveScopedModelProvider({ workspaceId }, this.deps)
    const ref = await this.modelFor(workspaceId)
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the bug-hunt ranking')
    }
    return { modelProvider, ref }
  }

  /** Workspace per-kind default > routing default (subscription refs degrade inline). */
  private async modelFor(workspaceId: string): Promise<ModelRef | undefined> {
    const fallback = this.deps.modelRef
    const runsInline = this.deps.runsInline
    const defaultId = await this.deps.resolveWorkspaceModelDefault?.(
      workspaceId,
      BUG_HUNT_AGENT_KIND,
    )
    const fromDefault = this.deps.resolveBlockModel?.(defaultId)
    if (fromDefault) {
      return inlineModelRef(fromDefault, fallback ?? fromDefault, runsInline ? { runsInline } : {})
    }
    return fallback
  }
}
