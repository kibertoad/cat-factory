import type {
  AgentContextSnapshot,
  BlockRepository,
  Clock,
  ExecutionEventPublisher,
  ExecutionInstance,
  IdGenerator,
  KaizenGrading,
  KaizenGradingRepository,
  KaizenOverview,
  KaizenVerifiedComboRepository,
  LlmCallMetric,
  LlmCallMetricRepository,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  PipelineStep,
  ProviderCapabilities,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import {
  DEFAULT_WORKSPACE_SETTINGS,
  extractJson,
  isModelUsableInline,
  resolveScopedModelProvider,
} from '@cat-factory/kernel'
import { generateText } from 'ai'
import {
  catFactoryObservability,
  KAIZEN_SYSTEM_PROMPT,
  promptVersionForKind,
  resolveInlineModelRef,
} from '@cat-factory/agents'
import type { AgentContextObservabilityService } from '../observability/AgentContextObservabilityService.js'
import { comboKeyFor, isVerified, nextComboState } from './kaizen.logic.js'

/** The agent kind keying the workspace default model + observability for the grader. */
const KAIZEN_AGENT_KIND = 'kaizen'

/** Newest LLM calls to digest into the grader prompt (the bodies are heavy). */
const MAX_CALLS_DIGESTED = 40

export interface KaizenServiceDependencies {
  kaizenGradingRepository: KaizenGradingRepository
  kaizenVerifiedComboRepository: KaizenVerifiedComboRepository
  blockRepository: BlockRepository
  llmCallMetricRepository: LlmCallMetricRepository
  /** Reads the complete context each step was given (system/user prompts + injected files). */
  agentContextObservability: AgentContextObservabilityService
  /** Reads the workspace's `kaizenEnabled` setting; absent ⇒ the default (on). */
  workspaceSettingsRepository?: WorkspaceSettingsRepository
  idGenerator: IdGenerator
  clock: Clock
  /** Pushes scheduled/running/complete transitions to an open run window. Optional. */
  events?: ExecutionEventPublisher
  /** Resolve a {@link ModelProvider} for a workspace's credential scope. Preferred. */
  modelProviderResolver?: ModelProviderResolver
  /** Static model provider (e.g. a fake in tests). Used when no resolver is set. */
  modelProvider?: ModelProvider
  /** Default model ref when nothing else resolves — the agents' routing default. */
  modelRef?: ModelRef
  /** Resolve a pinned model id to a ref (the deployment-aware resolver). */
  resolveBlockModel?: (modelId: string | undefined) => ModelRef | undefined
  /**
   * Whether a subscription harness ref can run as an INLINE call in this deployment (local
   * mode's ambient CLI). Keeps it instead of degrading to the routing default. Absent → degrade.
   */
  runsInline?: (ref: ModelRef) => boolean
  /** Resolve the workspace's per-kind default model id for the `kaizen` kind. */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  /**
   * Resolve what a workspace + run-initiator have configured (direct keys / subscriptions /
   * Cloudflare AI / local runners). Used to check that the grader's resolved model can
   * actually run the INLINE grading call before scheduling — a subscription-only model (or an
   * unconfigured one) would otherwise degrade to the routing default and fail. Absent → the
   * fitness check is skipped (tests / unconfigured facades) and grading is scheduled as before.
   */
  resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
  ) => Promise<ProviderCapabilities>
}

/**
 * The Kaizen agent: after a run completes, it grades each completed agent step by how
 * smooth / guided / efficient the interaction was vs confused / chaotic, and recommends
 * improvements. A combo `(promptVersion, agentKind, model)` that earns a high grade with
 * no recommendations enough times in a row is VERIFIED and stops being graded.
 *
 * Grading is two-phase so it never blocks a run: {@link scheduleForRun} (called from the
 * engine's terminal hook) only inserts `scheduled` rows; {@link runGrading} (driven by the
 * background sweep) does the LLM analysis. The grader resolves its model exactly like an
 * agent step — for the `kaizen` kind — so operators configure it in Model Configuration.
 */
export class KaizenService {
  constructor(private readonly deps: KaizenServiceDependencies) {}

  /** Whether the LLM-backed grader is available (else gradings settle as `failed`). */
  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  // ---- phase 1: schedule (called at run completion, never blocks) ----------

  /**
   * Schedule a grading for each completed agent step of a finished run, skipping verified
   * combos and steps already graded. Best-effort: a failure here must never derail the
   * engine's emit (the caller wraps it), and re-driving the same run is idempotent.
   */
  async scheduleForRun(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    // No grader model wired ⇒ every scheduled row could only ever settle `failed`, so don't
    // flood the table (and the run-window event stream) with rows for a disabled grader.
    if (!this.enabled) return
    if (!(await this.kaizenEnabled(workspaceId))) return
    // The grader is an inline LLM call. When the workspace's Kaizen model resolves to a
    // subscription-only model this deployment can't run inline (or to nothing configured at
    // all), the call would degrade to the routing default and fail — historically flooding the
    // table with `failed` rows blaming an unconfigured `qwen`. Skip the run entirely instead;
    // the SPA surfaces a banner asking the user to point Kaizen at a compatible model.
    if (!(await this.isModelReady(workspaceId, instance.blockId, instance.initiatedBy))) return
    for (let stepIndex = 0; stepIndex < instance.steps.length; stepIndex++) {
      const step = instance.steps[stepIndex]
      if (!step || !this.isGradeable(step) || !step.model) continue
      const model = step.model
      const promptVersion = promptVersionForKind(step.agentKind)
      const comboKey = comboKeyFor(step.agentKind, model, promptVersion)
      const combo = await this.deps.kaizenVerifiedComboRepository.getByKey(workspaceId, comboKey)
      if (isVerified(combo)) continue
      const existing = await this.deps.kaizenGradingRepository.getByStep(
        workspaceId,
        instance.id,
        stepIndex,
      )
      if (existing) continue
      const now = this.deps.clock.now()
      const grading: KaizenGrading = {
        id: this.deps.idGenerator.next('kzn'),
        executionId: instance.id,
        blockId: instance.blockId,
        stepIndex,
        agentKind: step.agentKind,
        model,
        promptVersion,
        comboKey,
        status: 'scheduled',
        grade: null,
        summary: '',
        recommendations: [],
        graderModel: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      }
      await this.deps.kaizenGradingRepository.upsert(workspaceId, grading)
      await this.emit(workspaceId, grading)
    }
  }

  // ---- phase 2: run (driven by the background sweep) -----------------------

  /**
   * Run a batch of pending gradings: `scheduled` rows plus `running` rows orphaned by a
   * crashed sweep (older than `staleBefore`). Returns how many it processed.
   */
  async runPending(staleBefore: number, limit: number): Promise<number> {
    const pending = await this.deps.kaizenGradingRepository.listPending(staleBefore, limit)
    let processed = 0
    for (const { workspaceId, grading } of pending) {
      // Atomically claim before working it: a concurrent/overlapping sweep pass that listed
      // the same row loses the claim and skips it, so a grading is processed at most once.
      const claimed = await this.deps.kaizenGradingRepository.claim(
        workspaceId,
        grading.id,
        staleBefore,
        this.deps.clock.now(),
      )
      if (!claimed) continue
      try {
        await this.runGrading(workspaceId, grading)
        processed++
      } catch {
        // runGrading already records a `failed` row; never let one bad grading abort the batch.
      }
    }
    return processed
  }

  /** Grade one step: mark running, digest telemetry, call the grader, record + update streak. */
  async runGrading(workspaceId: string, grading: KaizenGrading): Promise<void> {
    const running: KaizenGrading = {
      ...grading,
      status: 'running',
      updatedAt: this.deps.clock.now(),
    }
    await this.deps.kaizenGradingRepository.upsert(workspaceId, running)
    await this.emit(workspaceId, running)

    if (!this.enabled) {
      await this.fail(workspaceId, running, 'No model is configured for the Kaizen agent')
      return
    }

    // Safety net for a row scheduled while the model WAS fit but whose config changed since
    // (or a row left by an older build): refuse to run rather than degrade to an unconfigured
    // routing default and surface a confusing provider error.
    if (!(await this.isModelReady(workspaceId, grading.blockId))) {
      await this.fail(
        workspaceId,
        running,
        'No compatible model is configured for the Kaizen agent. Point Kaizen at a provider-backed model in Model Configuration.',
      )
      return
    }

    try {
      // Fetch only THIS step kind's calls (filtered in SQL) so the cap is spent on the
      // graded kind rather than being crowded out by a long run's other kinds. The metric
      // store keys calls by (execution, agentKind) — there is no per-step discriminator —
      // so if a run ran the SAME kind in two steps their calls are merged here; the
      // provided-context snapshot below is still matched precisely by stepIndex.
      const [snapshot, stepCalls] = await Promise.all([
        this.snapshotForStep(workspaceId, grading),
        this.deps.llmCallMetricRepository.listByExecution(
          workspaceId,
          grading.executionId,
          MAX_CALLS_DIGESTED,
          grading.agentKind,
        ),
      ])
      // Don't grade blind. With neither a provided-context snapshot NOR any recorded LLM
      // calls (e.g. the deployment has prompt recording off), the grader has no evidence to
      // judge the interaction on — it would be guessing, and a guessed high-grade-with-no-recs
      // would advance the combo streak toward a bogus `verified`, after which the engine stops
      // grading that combo for good. Settle `failed` instead so the combo is left untouched.
      if (!snapshot && stepCalls.length === 0) {
        await this.fail(
          workspaceId,
          running,
          'No telemetry was captured for this step (prompt recording may be off), so it cannot be graded',
        )
        return
      }
      const { ref, provider } = await this.resolveModel(workspaceId, grading.blockId)
      const model = provider.resolve(ref)
      const result = await generateText({
        model,
        system: KAIZEN_SYSTEM_PROMPT,
        prompt: buildKaizenPrompt(grading, snapshot, stepCalls),
        temperature: 0.2,
        maxOutputTokens: 2000,
        providerOptions: catFactoryObservability({ agentKind: KAIZEN_AGENT_KIND, workspaceId }),
      })
      const verdict = parseVerdict(result.text)
      const now = this.deps.clock.now()
      const complete: KaizenGrading = {
        ...grading,
        status: 'complete',
        grade: verdict.grade,
        summary: verdict.summary,
        recommendations: verdict.recommendations,
        graderModel: `${ref.provider}:${ref.model}`,
        error: null,
        updatedAt: now,
      }
      await this.deps.kaizenGradingRepository.upsert(workspaceId, complete)
      await this.updateCombo(workspaceId, complete, now)
      await this.emit(workspaceId, complete)
    } catch (e) {
      await this.fail(workspaceId, running, e instanceof Error ? e.message : String(e))
    }
  }

  // ---- read surface -------------------------------------------------------

  /** The Kaizen screen payload: recent history + the verified-combo library. */
  async getOverview(workspaceId: string, limit = 200): Promise<KaizenOverview> {
    const [gradings, verified] = await Promise.all([
      this.deps.kaizenGradingRepository.listByWorkspace(workspaceId, limit),
      this.deps.kaizenVerifiedComboRepository.listByWorkspace(workspaceId),
    ])
    return { gradings, verified }
  }

  /** The gradings recorded for a single run (the run-window status surface). */
  listForExecution(workspaceId: string, executionId: string): Promise<KaizenGrading[]> {
    return this.deps.kaizenGradingRepository.listByExecution(workspaceId, executionId)
  }

  // ---- internals ----------------------------------------------------------

  private async kaizenEnabled(workspaceId: string): Promise<boolean> {
    if (!this.deps.workspaceSettingsRepository) return DEFAULT_WORKSPACE_SETTINGS.kaizenEnabled
    const settings = await this.deps.workspaceSettingsRepository.get(workspaceId)
    return settings?.kaizenEnabled ?? DEFAULT_WORKSPACE_SETTINGS.kaizenEnabled
  }

  /** A step is gradeable when it ran an LLM to completion (so it has a resolved model). */
  private isGradeable(step: PipelineStep): boolean {
    return step.state === 'done' && !step.skipped && !!step.model
  }

  private async snapshotForStep(
    workspaceId: string,
    grading: KaizenGrading,
  ): Promise<AgentContextSnapshot | null> {
    const snapshots = await this.deps.agentContextObservability.listByExecution(
      workspaceId,
      grading.executionId,
    )
    return (
      snapshots.find((s) => s.stepIndex === grading.stepIndex) ??
      snapshots.find((s) => s.agentKind === grading.agentKind) ??
      null
    )
  }

  private async resolveModel(
    workspaceId: string,
    blockId: string,
  ): Promise<{ provider: ModelProvider; ref: ModelRef }> {
    const provider = await resolveScopedModelProvider(workspaceId, this.deps)
    const ref = await this.modelFor(workspaceId, blockId)
    if (!provider || !ref) throw new Error('No model is configured for the Kaizen agent')
    return { provider, ref }
  }

  /**
   * The grader's model. Kaizen grading is just another inline LLM step, so it resolves its
   * model through the SAME shared seam every inline agent uses ({@link resolveInlineModelRef}
   * — block pin > workspace per-kind default > routing default, keeping an ambient-eligible
   * subscription harness ref instead of degrading it) rather than re-deriving that precedence
   * here. Returns undefined only when no routing default is wired (grader disabled).
   */
  private async modelFor(workspaceId: string, blockId: string): Promise<ModelRef | undefined> {
    if (!this.deps.modelRef) return undefined
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    return resolveInlineModelRef(
      {
        agentRouting: { default: { ref: this.deps.modelRef }, byKind: {} },
        resolveBlockModel: this.deps.resolveBlockModel ?? (() => undefined),
        resolveWorkspaceModelDefault: this.deps.resolveWorkspaceModelDefault,
        ...(this.deps.runsInline ? { runsInline: this.deps.runsInline } : {}),
      },
      {
        agentKind: KAIZEN_AGENT_KIND,
        blockModelId: block?.modelId,
        modelPresetId: block?.modelPresetId,
        workspaceId,
      },
    )
  }

  /**
   * Whether a FITTING model is configured for the inline Kaizen grader in this workspace.
   * Resolves the grader's model id the same way {@link modelFor} resolves its ref — block pin >
   * workspace per-kind default for the `kaizen` kind — then checks it with
   * {@link isModelUsableInline}: a subscription-only model with no inline harness (or a model
   * with no usable provider at all) is NOT fit, because the inline `generateText` call can't
   * drive it. Returns `true` when no capability resolver is wired (tests / unconfigured facades)
   * so grading behaviour there is unchanged.
   */
  private async isModelReady(
    workspaceId: string,
    blockId: string,
    initiatedBy?: string | null,
  ): Promise<boolean> {
    if (!this.deps.resolveProviderCapabilities) return true
    const caps = await this.deps.resolveProviderCapabilities(workspaceId, initiatedBy)
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    let id = block?.modelId
    if (!id && this.deps.resolveWorkspaceModelDefault) {
      id = await this.deps.resolveWorkspaceModelDefault(
        workspaceId,
        KAIZEN_AGENT_KIND,
        block?.modelPresetId,
      )
    }
    return isModelUsableInline(id, caps, this.deps.runsInline)
  }

  private async updateCombo(
    workspaceId: string,
    grading: KaizenGrading,
    now: number,
  ): Promise<void> {
    const prev = await this.deps.kaizenVerifiedComboRepository.getByKey(
      workspaceId,
      grading.comboKey,
    )
    const next = nextComboState(prev, grading, now)
    await this.deps.kaizenVerifiedComboRepository.upsert(workspaceId, next)
  }

  private async fail(workspaceId: string, grading: KaizenGrading, message: string): Promise<void> {
    const failed: KaizenGrading = {
      ...grading,
      status: 'failed',
      error: message,
      updatedAt: this.deps.clock.now(),
    }
    await this.deps.kaizenGradingRepository.upsert(workspaceId, failed)
    await this.emit(workspaceId, failed)
  }

  private async emit(workspaceId: string, grading: KaizenGrading): Promise<void> {
    try {
      await this.deps.events?.kaizenGradingChanged?.(workspaceId, grading)
    } catch {
      // Best-effort push; the persisted row is the source of truth.
    }
  }
}

/** Parsed grader verdict, clamped to the valid grade range. */
interface KaizenVerdict {
  grade: number
  summary: string
  recommendations: string[]
}

/** Pull the first JSON object out of the grader's reply and coerce it to a verdict. */
function parseVerdict(text: string): KaizenVerdict {
  // Use the shared, string-literal-aware extractor (handles prose/braces around the
  // object and fenced code blocks) rather than a naive first-`{`/last-`}` slice.
  const parsed = extractJson(text)
  const json =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  if (!json) throw new Error('Kaizen grader returned no parseable JSON verdict')
  const rawGrade = typeof json.grade === 'number' ? json.grade : Number(json.grade)
  if (!Number.isFinite(rawGrade)) throw new Error('Kaizen grader returned no numeric grade')
  const grade = Math.min(5, Math.max(1, Math.round(rawGrade)))
  const summary = typeof json.summary === 'string' ? json.summary : ''
  const recommendations = Array.isArray(json.recommendations)
    ? json.recommendations.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : []
  return { grade, summary, recommendations }
}

/** Build the grader's user prompt: the provided context + an interaction-telemetry digest. */
function buildKaizenPrompt(
  grading: KaizenGrading,
  snapshot: AgentContextSnapshot | null,
  calls: LlmCallMetric[],
): string {
  const parts: string[] = []
  parts.push(
    `Grade this completed agent step.\n` +
      `Agent kind: ${grading.agentKind}\nModel: ${grading.model}\nPrompt version: ${grading.promptVersion}`,
  )

  if (snapshot) {
    if (snapshot.systemPrompt)
      parts.push(`=== SYSTEM PROMPT GIVEN TO THE AGENT ===\n${snapshot.systemPrompt}`)
    if (snapshot.userPrompt)
      parts.push(`=== USER PROMPT GIVEN TO THE AGENT ===\n${snapshot.userPrompt}`)
    if (snapshot.fragments.length > 0) {
      parts.push(
        `=== BEST-PRACTICE FRAGMENTS FOLDED IN ===\n` +
          snapshot.fragments.map((f) => `- ${f.id}`).join('\n'),
      )
    }
    if (snapshot.contextFiles.length > 0) {
      parts.push(
        `=== CONTEXT FILES INJECTED ===\n` +
          snapshot.contextFiles.map((f) => `- ${f.path} (${f.content.length} chars)`).join('\n'),
      )
    }
  } else {
    parts.push(
      'No provided-context snapshot was captured for this step (prompt recording may be off). ' +
        'Grade primarily from the interaction telemetry below.',
    )
  }

  parts.push(`=== INTERACTION TELEMETRY ===\n${digestCalls(calls)}`)
  return parts.join('\n\n')
}

/** A compact, model-readable digest of the per-call telemetry for one step. */
function digestCalls(calls: LlmCallMetric[]): string {
  if (calls.length === 0) return 'No LLM calls were recorded for this step.'
  const truncated = calls.filter((c) => c.finishReason === 'length').length
  const errors = calls.filter((c) => !c.ok).length
  const promptTokens = calls.reduce((s, c) => s + c.promptTokens, 0)
  const completionTokens = calls.reduce((s, c) => s + c.completionTokens, 0)
  const finishReasons = summarizeCounts(calls.map((c) => c.finishReason ?? 'unknown'))
  const lines = [
    `Total model calls: ${calls.length}`,
    `Truncated calls (hit output limit): ${truncated}`,
    `Failed calls: ${errors}`,
    `Prompt tokens (sum): ${promptTokens}`,
    `Completion tokens (sum): ${completionTokens}`,
    `Finish reasons: ${finishReasons}`,
  ]
  const last = calls[0] // newest first
  if (last?.responseText) {
    lines.push(
      `Final visible response (truncated to 2000 chars):\n${last.responseText.slice(0, 2000)}`,
    )
  }
  if (errors > 0) {
    const messages = calls
      .filter((c) => !c.ok && c.errorMessage)
      .slice(0, 5)
      .map((c) => `- ${c.errorMessage}`)
    if (messages.length) lines.push(`Error messages:\n${messages.join('\n')}`)
  }
  return lines.join('\n')
}

function summarizeCounts(values: string[]): string {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(', ')
}
