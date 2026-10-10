import { runDefaultScopeFor } from '@cat-factory/contracts'
import type { PublicApiScope, PublicPipeline } from '@cat-factory/contracts'
import { scopeSatisfies } from '@cat-factory/integrations'
import type { ServerContainer } from '../../http/env.js'
import { type AdmissionRegistries, isHeadlessInlinePipeline } from './publicApiAdmission.js'

// ---------------------------------------------------------------------------
// WHICH PIPELINE a headless caller gets, and how one is described back to it.
//
// Split out of `PublicApiController` as one seam rather than three helpers: the start route, the
// listing and the projection are the same question asked from two sides, and the whole point of the
// list-level report is that it CANNOT resolve the default differently from the route that acts on
// it. Keeping them together is what makes that guarantee something a reader can check.
// ---------------------------------------------------------------------------

/**
 * The pipeline a headless START runs: the request's, else the task's pinned pipeline, else the
 * workspace's default for a run NOTHING IS WATCHING (`runDefaultScopeFor('public-api')`). `null`
 * when the workspace declares none of the three, which is this surface's documented
 * `pipeline_required` refusal — a caller here has no run-time picker, so inventing a rung for it
 * would run work nobody chose — and `null` for a `write` key whatever the workspace declares (see
 * the scope check below).
 *
 * The scope rung is what makes the headless door land on a headless-shaped pipeline rather than on
 * whatever an in-app board happens to default to: the seeded `pl_unattended` holds no requirements
 * conversation and reaches its human doors only by measured risk. Resolved HERE rather than inside
 * `ExecutionService.start`, so the refusal stays with the surface that documents it.
 */
export async function startPipelineIdFor(
  container: ServerContainer,
  auth: { workspaceId: string; scope: PublicApiScope },
  named: { requested?: string | undefined; pinned?: string | undefined },
): Promise<string | null> {
  if (named.requested) return named.requested
  if (named.pinned) return named.pinned
  return unattendedDefaultPipelineIdFor(container, auth)
}

/**
 * What an EMPTY start body runs for this key, or `null` when it would answer `pipeline_required`.
 *
 * The ONE answer to that question, called by the route that acts on it and by `GET /pipelines`,
 * which reports it. Two readings would be worse than none: the report is only worth exposing
 * because a caller cannot otherwise discover what omitting `pipelineId` does, and a report that
 * resolves the workspace's default differently from the start route is a caller confidently sending
 * an empty body at a 400.
 *
 * A default the CALLER could not answer is not a usable default for that caller. The seeded rung
 * reaches a human test and a human PR review on a risky task, which `unanswerableParkRefusal`
 * rightly withholds from a plain `write` key, so resolving it would trade this surface's actionable
 * "pass a pipelineId" for a 403 about a pipeline the caller never picked. A `write` key therefore
 * keeps exactly its previous behaviour, and only a `decide` key gains the fallback.
 */
export async function unattendedDefaultPipelineIdFor(
  container: ServerContainer,
  auth: { workspaceId: string; scope: PublicApiScope },
): Promise<string | null> {
  if (!scopeSatisfies(auth.scope, 'decide')) return null
  return container.pipelineService.defaultPipelineIdForScope(
    auth.workspaceId,
    runDefaultScopeFor('public-api'),
  )
}

/**
 * Project an internal pipeline onto the external pipeline resource: its id/name, the enabled
 * step chain (in order), the two headless-relevant flags a caller needs to choose a `pipelineId`
 * for `start` — `public` (job-startable via `POST /jobs`) and `headlessStartable` (safe to run with
 * no interactive user) — and whether it is what an empty start body resolves. Archived pipelines
 * are filtered out by the caller.
 */
export function toPublicPipeline(
  pipeline: {
    id: string
    name: string
    agentKinds: string[]
    enabled?: boolean[]
    gates?: boolean[]
    public?: boolean
  },
  registries: AdmissionRegistries,
  unattendedDefaultPipelineId: string | null,
): PublicPipeline {
  return {
    pipelineId: pipeline.id,
    name: pipeline.name,
    steps: pipeline.agentKinds.filter((_, i) => pipeline.enabled?.[i] !== false),
    public: pipeline.public === true,
    headlessStartable: isHeadlessInlinePipeline(pipeline, registries),
    // Marked off the RESOLVED id, never off the row's own stored flag. The resolution has a second
    // rung (the catalog's declared rung, while the workspace holds no row for it) and a scope rule,
    // so a row-level read answers `false` everywhere on a workspace whose empty start bodies have
    // been working all along.
    unattendedDefault: pipeline.id === unattendedDefaultPipelineId,
  }
}
