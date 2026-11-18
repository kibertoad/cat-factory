import type { JudgeAssessor, JudgeModelPin, JudgeSubject } from '@cat-factory/kernel'
import { JUDGE_SYSTEM_PROMPT, renderJudgePrompt } from '@cat-factory/agents'
import {
  type InlineJsonAssessmentDeps,
  inlineJsonAssessmentEnabled,
  runInlineJsonAssessment,
} from './inlineJsonAssessment.js'

// ---------------------------------------------------------------------------
// The default {@link JudgeAssessor}: the INLINE LLM call behind every judge step.
//
// The call itself is `runInlineJsonAssessment`, shared with a project stage's acceptance
// assessment, with two judge specifics. A judge's deliverable is a JSON object the engine PARSES, so
// this returns the raw extracted value and lets the judge's registered parser own the shape;
// and the resolution keys on the JUDGE'S OWN kind and admits one more layer, the model the
// registration pinned for its rubric (see `assess`).
//
// It is deliberately STATELESS: all judge state rides the run's step (`step.judge`), so there
// is no side table and the runtimes cannot drift. It is built in `createCore` from the
// model-provider dependencies every facade already wires, which is why adding judges required
// no per-facade wiring at all — and why a conformance harness can swap in a deterministic fake
// through the same `judgeAssessor` seam.
//
// `enabled === false` (no provider or no routing default) ⇒ the engine's judge steps are
// pass-throughs, so pipelines and the conformance/e2e suites run exactly as before.
// ---------------------------------------------------------------------------

/** What the inline assessor needs to resolve its model and reach the provider. */
export type JudgeServiceDeps = InlineJsonAssessmentDeps

/** How long a judge assessment may run before it is abandoned and recorded as failing. */
const JUDGE_TIMEOUT_MS = 120_000

export class JudgeService implements JudgeAssessor {
  constructor(private readonly deps: JudgeServiceDeps) {}

  /** Whether an assessment can run (a provider AND a routing default are wired). */
  get enabled(): boolean {
    return inlineJsonAssessmentEnabled(this.deps)
  }

  /**
   * Run ONE assessment against the rubric in force. Returns the raw extracted JSON value (the
   * judge's registered parser owns the shape) plus the model that produced it.
   *
   * The model resolves under the JUDGE'S OWN kind, so each registered rubric is its own row in the
   * workspace's model defaults and its own spend line: task pin > a preset override naming this
   * judge's kind > the registration's {@link JudgeSubject.modelId} > the preset's base model > the
   * routing default, with `modelPin` saying which won.
   *
   * Throws {@link ValidationError} on an unresolved model, a failed or timed-out generation, or a
   * reply with no JSON object in it. The engine catches that and records a FAILING verdict rather
   * than crashing the run: an assessment that could not be read must never pass for a clean one.
   */
  async assess(
    subject: JudgeSubject,
  ): Promise<{ verdict: unknown; model: string; modelPin?: JudgeModelPin }> {
    const { value, model, pin } = await runInlineJsonAssessment(this.deps, {
      workspaceId: subject.workspaceId,
      block: subject.block,
      kind: subject.step.agentKind,
      ...(subject.modelId ? { modelId: subject.modelId } : {}),
      label: 'judge assessment',
      system: JUDGE_SYSTEM_PROMPT,
      prompt: renderJudgePrompt(subject),
      maxOutputTokens: 2000,
      timeoutMs: JUDGE_TIMEOUT_MS,
    })
    return { verdict: value, model, ...(pin ? { modelPin: pin } : {}) }
  }
}
