import {
  getPublicServiceSpecContract,
  type PublicSpecProvenance,
  type ServiceSpecView,
} from '@cat-factory/contracts'
import { readServiceSpec } from '@cat-factory/agents'
import type { RunRepoContext } from '@cat-factory/kernel'
import { NotFoundError, UnavailableError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { authorizeOrThrow } from './publicApiAuth.js'
import { toPublicServiceSpec } from './specProjection.js'

// The public SPEC read (`GET /api/v1/services/:serviceId/spec`): the service's in-repo prescriptive
// specification (the structured requirement tree and the Gherkin rendered from it) for a consumer
// holding only an API key.
//
// It exists because the requirement ids on `GET /api/v1/runs/:runId/report` and `…/outcome` were a
// join key onto a document no headless caller could fetch. With this, reviewing a run's outcome
// against the criteria it was scored on is two GETs and a map lookup, with no repository clone and
// no VCS credential.
//
// Everything below is one idea applied four times: **a spec read has four outcomes and this
// controller refuses to fold them**, because the fold is silent and always in the same direction.
// The internal view the app's requirements window consumes reports `present: false` for both "this
// branch holds no spec" and "we could not read the repository", which is right for a window that
// draws an empty state and wrong here: it would tell every integrator that every service is
// requirement-free for the duration of a VCS incident, and nothing in the payload would say
// otherwise.
//
//  1. **No VCS integration wired** → `503`, `reason: "vcs_not_configured"`. The deployment, not the
//     service.
//  2. **The repository could not be read** → `503`, `reason: "spec_read_failed"`. Retry; the spec
//     may well be there.
//  3. **No spec on the default branch** → `200`, `present: false`. A real, common, final answer.
//  4. **A spec that read partially** → `200` with the tree, `issues` naming every file that did not
//     survive and `truncations` naming every cap that bit.
//
// A fifth case is not this controller's to invent: a service frame with no linked repository throws
// the same `ValidationError` (a `422`) that `resolveRepoTarget` raises everywhere else, because
// execution refuses that service too and a read that answered "no requirements" would describe a
// service nothing can run as one that simply has nothing to say.
//
// Two further notes on what this is NOT. It is not a subscription: the spec on the default branch
// is not the spec a run with an open pull request is working against, which is why the response
// names the commit it describes. And there is no write half, deliberately: the files are the truth
// and the write path is a reviewed commit (see `../../../../../contracts/src/public-spec.ts`).

/** The refusal for an id that names no service this key may read. */
const serviceNotFound = (serviceId: string) =>
  new NotFoundError('Service', serviceId, { reason: 'service_not_found' })

/**
 * The run-repo resolver, or the 503 that names what this deployment has not wired.
 *
 * A total accessor rather than a nullable read the route re-refuses, the shape `http/guards.ts`
 * describes. It carries its own `reason` rather than going through `requireCapability`, because on
 * this surface the machine-readable code is the whole remedy: a headless caller has no setup screen
 * to be sent to and branches on the string.
 */
function requireRepoResolver<E extends AppEnv>(c: Context<E>) {
  const resolve = c.get('container').resolveRunRepoContext
  if (!resolve) {
    throw new UnavailableError(
      'No version-control integration is configured for this deployment',
      'vcs_not_configured',
    )
  }
  return resolve
}

/**
 * The head commit of the branch the spec is read from, or null when it cannot be resolved.
 *
 * Read BEFORE the tree walk, so the commit named is one the tree is at least as new as. It is
 * best-effort on purpose: a repository that serves its files but not its ref (a provider partly
 * degraded, a client binding without the capability) should answer the spec with an unnamed commit
 * rather than refuse a read that would have succeeded. The tree walk's own failures are what decide
 * outcome 2, and they are reported by the reader.
 */
async function resolveCommit(ctx: RunRepoContext): Promise<string | null> {
  try {
    return await ctx.repo.headSha(ctx.baseBranch)
  } catch {
    return null
  }
}

/** Where the tree was read from, for a response that has to stand alone. */
function provenanceOf(ctx: RunRepoContext, commit: string | null): PublicSpecProvenance {
  return {
    provider: ctx.provider ?? 'github',
    // The resolver's owner/name are optional for back-compat with older fakes; the real resolvers
    // always set them, and an empty string is the honest stand-in for a binding that did not.
    owner: ctx.owner ?? '',
    repo: ctx.name ?? '',
    ref: ctx.baseBranch,
    commit,
  }
}

/**
 * Refuse a view whose emptiness is an OUTAGE rather than an answer.
 *
 * The one place the four outcomes are separated, and it reads off the reader's own `anchor` rather
 * than re-probing: `absent` and `unparsed` are facts about the repository (no spec / a corrupt
 * `spec/service.json`, the latter carried as an `issue` so the caller learns which file), and
 * `read_failed` is a fact about the provider.
 */
function assertSpecReadable(view: ServiceSpecView): void {
  if (view.diagnostics?.anchor !== 'read_failed') return
  throw new UnavailableError(
    "The service's repository could not be read; the spec may exist but could not be fetched",
    'spec_read_failed',
  )
}

export function publicSpecController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getPublicServiceSpecContract, async (c) => {
    const auth = await authorizeOrThrow(c, getPublicServiceSpecContract.minScope)
    const { workspaceId } = auth
    const { serviceId } = c.req.valid('param')
    const container = c.get('container')
    // Resolve the service before the resolver's 503, so a mistyped id is answered by the 404 it
    // deserves rather than by a report on the deployment's wiring.
    if (!(await container.boardService.getService(workspaceId, serviceId))) {
      throw serviceNotFound(serviceId)
    }
    // The repo resolution walks the block's ancestry to the enclosing service frame and reads that
    // frame's linked repository: the same seam the engine binds a run's pre/post-ops through, and
    // deliberately with no "first repo" fallback. A service under no linked repo THROWS out of
    // here (a 422), which is the answer every other surface gives it.
    const ctx = await requireRepoResolver(c)(workspaceId, serviceId)
    if (!ctx) {
      throw new UnavailableError(
        'No version-control integration is connected for this workspace',
        'vcs_not_configured',
      )
    }
    const commit = await resolveCommit(ctx)
    // `readServiceSpec` is the ONE spec reader: the same walk, the same per-node salvage and the
    // same diagnostics the app's window and the run-evidence reductions read through. A second
    // reader here is how two surfaces come to disagree about what a malformed group renders as.
    const view = await readServiceSpec(ctx.repo, ctx.baseBranch)
    assertSpecReadable(view)
    return c.json(toPublicServiceSpec(serviceId, view, provenanceOf(ctx, commit)), 200)
  })

  return app
}
