import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Agent effort-report wire contract. Every CONTAINER agent is asked to end its
// run by writing a short self-assessment — how hard/easy the work was, what
// reduced its effectiveness, and the key obstacles it hit — to a sentinel file in
// its working directory (the harness reads it, keeps it out of the commit). The
// harness lifts it onto the job result, the engine records it on the step
// (`PipelineStep.effortReport`), and it is surfaced in run details. Lenient by
// construction (a partial/absent report degrades to safe defaults) so a malformed
// self-report never fails an otherwise-successful run.
// ---------------------------------------------------------------------------

/**
 * A container agent's self-assessment of the work it just finished. `difficulty` is
 * 1 (trivial) .. 10 (extremely hard); `summary` explains the rating in a sentence or
 * two; `reducedEffectiveness` names what held the agent back (unclear requirements,
 * flaky tooling, missing context, …); `obstacles` lists the concrete blockers hit.
 */
export const agentEffortReportSchema = v.object({
  /** How hard the work was: 1 (trivial) .. 10 (extremely hard). */
  difficulty: v.fallback(v.pipe(v.number(), v.minValue(1), v.maxValue(10)), 5),
  /** One or two sentences on how hard/easy the work was and why. */
  summary: v.fallback(v.optional(v.string()), undefined),
  /** What reduced the agent's effectiveness (unclear reqs, flaky tooling, missing context, …). */
  reducedEffectiveness: v.fallback(v.optional(v.string()), undefined),
  /** The key obstacles the agent hit while doing the work. */
  obstacles: v.fallback(v.optional(v.array(v.string())), undefined),
})
export type AgentEffortReport = v.InferOutput<typeof agentEffortReportSchema>

/** Non-throwing parse of an effort report the agent wrote; `undefined` when unusable. */
export function safeParseAgentEffortReport(value: unknown): AgentEffortReport | undefined {
  const result = v.safeParse(agentEffortReportSchema, value)
  return result.success ? result.output : undefined
}
