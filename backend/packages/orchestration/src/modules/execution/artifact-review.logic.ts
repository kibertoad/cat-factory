import {
  renderBlueprintForReview,
  renderSpecForReview,
  safeParseBlueprintService,
  safeParseSpecDoc,
} from '@cat-factory/contracts'
import type { AgentRunResult } from '@cat-factory/kernel'

/**
 * The text a companion (and the SPA reader, and downstream steps via `priorOutputs`)
 * should review for a finished producer step, or `undefined` when the step's own
 * `output` already IS the work product.
 *
 * A producer that emits a STRUCTURED ARTIFACT (the spec doc, the blueprint tree, …)
 * runs as a container agent: it commits the artifact to the repo and returns its raw
 * Pi transcript summary as `result.output`. That summary is a useless thing to grade
 * — it was what made the spec-companion declare every pass "unreviewable" and loop the
 * producer to its rework cap on every spec task. So whenever a known artifact is
 * present, the reviewable output is a deterministic rendering of the ARTIFACT itself.
 *
 * This is the universal seam: it is keyed off WHICH artifact the result carries, not
 * off a specific `agentKind`, so every artifact-producing agent with a companion —
 * today's spec-writer, and any future one — is covered by rendering its artifact here
 * rather than by another per-agent special case. A producer whose work product is
 * already prose (architect, researcher, the coder's PR summary) carries no artifact
 * field and falls through to `undefined`, keeping its own `output`.
 *
 * Falls back to `undefined` when the artifact is present but won't parse (the in-repo
 * files are committed regardless, so the raw summary is kept rather than nothing).
 */
export function reviewableArtifactOutput(result: AgentRunResult): string | undefined {
  if (result.spec !== undefined) {
    const doc = safeParseSpecDoc(result.spec)
    return doc ? renderSpecForReview(doc) : undefined
  }
  if (result.blueprintService !== undefined) {
    const service = safeParseBlueprintService(result.blueprintService)
    return service ? renderBlueprintForReview(service) : undefined
  }
  // `testReport` / `mergeAssessment` carry their own dedicated structured surfaces
  // (the tester result view; the merger is the final step) and no prose companion
  // grades them today. If one ever gains a companion, render it here — the seam, not
  // the call sites, is where a new artifact type is taught to be reviewable.
  return undefined
}
