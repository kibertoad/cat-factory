import { defineApiContract } from '@toad-contracts/valibot'
import {
  connectPublicEnvironmentSchema,
  publicBootstrapJobSchema,
  publicBootstrapRepoSchema,
  publicEnvironmentConnectionTestSchema,
  publicEnvironmentConnectionViewSchema,
  publicMergePresetListSchema,
  publicVcsConnectionViewSchema,
  publicWiredModelListSchema,
  testPublicEnvironmentConnectionSchema,
  updatePublicServiceSchema,
} from '../public-provisioning.js'
import { publicServiceSchema } from '../public-api.js'
import { errorResponses, singleStringParam, withMinScope } from './_shared.js'

// ---------------------------------------------------------------------------
// DEPLOYMENT PROVISIONING on `/api/v1`: the setup half of the surface.
//
// Its own file rather than more of `public-board.ts`, which carries what a caller does to a board
// that already exists. These come EARLIER than that: they are what a caller does to a workspace
// which has nothing to file work against yet. The split is the same one `public-board.ts` made when
// it separated setting a board up from running one task through it.
//
// **Scope: `admin` throughout, including the reads.** Two different arguments land in the same
// place. The writes create repositories, bind infrastructure credentials and change where a service
// deploys, which is board STRUCTURE and beyond, so `admin` is the floor by the same reading that
// put service creation there. The READS are `admin` for a different reason: unlike `/repos` or
// `/pipelines`, which name board content, these name what the DEPLOYMENT has wired, including the
// permissions its VCS credential holds and the clusters it can reach. That is operator-facing
// information, and a caller holding it is already at the rung that could change it.
//
// Where the reading was close, the REVERSIBLE one wins (ADR 0034): `admin` can be relaxed to `read`
// later, and a scope can never be tightened, because narrowing what a live key may do is a break
// however small it looks.
// ---------------------------------------------------------------------------

const jobIdParams = singleStringParam('jobId')
const serviceIdParams = singleStringParam('serviceId')

// ---- repo bootstrap ---------------------------------------------------------

/**
 * Create a repository and adapt it with the bootstrapper agent.
 *
 * Asynchronous by construction, like every other agent run on this surface: it answers 201 with a
 * job to poll rather than blocking for the minutes a container takes. The job's `serviceId` is the
 * board frame the run materialises, so a caller can file work against the service before the
 * repository itself has finished being written.
 */
export const startPublicRepoBootstrapContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'post',
    pathResolver: () => '/api/v1/repos/bootstrap',
    requestBodySchema: publicBootstrapRepoSchema,
    responsesByStatusCode: { 201: publicBootstrapJobSchema, ...errorResponses },
  }),
)

/** Poll one bootstrap run. Idempotent, and the only way to learn a run's outcome. */
export const getPublicRepoBootstrapContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: jobIdParams,
    pathResolver: ({ jobId }) => `/api/v1/repos/bootstrap/${jobId}`,
    responsesByStatusCode: { 200: publicBootstrapJobSchema, ...errorResponses },
  }),
)

// ---- the environment connection (the ENGINE half) ---------------------------

/**
 * Probe a candidate connection without persisting it.
 *
 * Worth its own endpoint rather than letting the register call find out, because the two failures
 * surface in completely different places: an unreachable apiserver or an expired token discovered
 * here is a setup error a caller can act on immediately, where the same fault discovered later
 * surfaces on the `deployer` step of a run that has already paid for a design pass and an
 * implementation.
 */
export const testPublicEnvironmentConnectionContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'post',
    pathResolver: () => '/api/v1/environments/connections/test',
    requestBodySchema: testPublicEnvironmentConnectionSchema,
    responsesByStatusCode: { 200: publicEnvironmentConnectionTestSchema, ...errorResponses },
  }),
)

/**
 * Bind the workspace's environment provisioning to a cluster. Idempotent: re-connecting replaces.
 *
 * The path is `/connections` rather than the internal `/handlers`: a caller is describing a
 * connection to infrastructure, where "handler" names the engine-side object that services it, and
 * a frozen surface should carry the caller's vocabulary rather than the engine's.
 */
export const connectPublicEnvironmentContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'post',
    pathResolver: () => '/api/v1/environments/connections',
    requestBodySchema: connectPublicEnvironmentSchema,
    responsesByStatusCode: { 201: publicEnvironmentConnectionViewSchema, ...errorResponses },
  }),
)

// ---- a service's provisioning (the SOURCE half) -----------------------------

/**
 * Patch a service: its authored fields, and where its per-run manifests live.
 *
 * The provisioning half is why this exists. A cluster connection alone provisions nothing, because
 * the platform deliberately keeps "which cluster" (one per workspace) apart from "which manifests"
 * (one set per service), and a caller with no way to declare the second could connect a cluster and
 * still watch every `deployer` step report an empty manifest source.
 *
 * No board COORDINATES here, exactly as `POST /api/v1/services` has none: position, size and
 * reparenting stay off a surface that is frozen forever.
 */
export const updatePublicServiceContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'patch',
    requestPathParamsSchema: serviceIdParams,
    pathResolver: ({ serviceId }) => `/api/v1/services/${serviceId}`,
    requestBodySchema: updatePublicServiceSchema,
    responsesByStatusCode: { 200: publicServiceSchema, ...errorResponses },
  }),
)

// ---- what this deployment has WIRED -----------------------------------------

/**
 * The workspace's model catalog, with the two flags that decide whether a run can dispatch.
 *
 * The alternative to serving this is not a different call, it is a caller discovering an unwired
 * model forty minutes into a run it has already paid for.
 */
export const listPublicWiredModelsContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/models',
    responsesByStatusCode: { 200: publicWiredModelListSchema, ...errorResponses },
  }),
)

/**
 * The workspace's VCS connection and what it may do, or `connection: null` when nothing is
 * connected. Provider-neutral: a GitLab-connected workspace answers here too, and the row's own
 * `provider` says which instance it talks to.
 */
export const getPublicVcsConnectionContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/vcs/connection',
    responsesByStatusCode: { 200: publicVcsConnectionViewSchema, ...errorResponses },
  }),
)

/**
 * The workspace's merge-preset library. The `isDefault` row is the policy a task that pins none
 * resolves, so it is the one that decides whether this caller's runs can land without a person.
 */
export const listPublicMergePresetsContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/merge-presets',
    responsesByStatusCode: { 200: publicMergePresetListSchema, ...errorResponses },
  }),
)
