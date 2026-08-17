import * as v from 'valibot'
import { defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import {
  connectPublicEnvironmentSchema,
  linkPublicRepoSchema,
  publicAvailableRepoListSchema,
  publicBootstrapJobSchema,
  publicBootstrapRepoSchema,
  publicEnvironmentConnectionTestSchema,
  publicEnvironmentConnectionViewSchema,
  publicEnvironmentHandlerListSchema,
  publicModelPresetListSchema,
  publicRepoFilePathSchema,
  publicRepoFileSchema,
  publicRiskPolicyListSchema,
  publicTrackerWritebackSettingsSchema,
  publicVcsConnectionViewSchema,
  publicWiredModelListSchema,
  testPublicEnvironmentConnectionSchema,
  updatePublicServiceSchema,
  updatePublicTrackerWritebackSchema,
} from '../public-provisioning.js'
import { publicServiceSchema } from '../public-api.js'
import { publicRepoSchema } from '../public-board.js'
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

// ---- adopting a repository that already exists -------------------------------

/**
 * The repositories the workspace's connection can REACH, linked or not.
 *
 * The discovery half of {@link linkPublicRepoContract}, and the read that makes an absent repository
 * diagnosable: `GET /api/v1/repos` lists what this workspace has LINKED, so a repository that exists
 * and is reachable is missing from it in exactly the way one that was never created is, and those
 * need opposite fixes. Here, the first appears with `linked: false` and the second does not appear.
 *
 * `q` filters server-side, as the app's own picker does, because a wide installation can reach
 * thousands of repositories: pass `owner/name` for an exact point-read (authoritative for
 * reachability, where a name search can miss an exact slug), a substring to search, or nothing to
 * browse what is accessible. Each call reaches the provider, so it is a setup-time read rather than
 * one to poll.
 */
export const listPublicAvailableReposContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/repos/available',
    requestQuerySchema: v.object({ q: v.optional(v.string()) }),
    responsesByStatusCode: { 200: publicAvailableRepoListSchema, ...errorResponses },
  }),
)

/**
 * Adopt a reachable repository into this workspace, so a service can be created against it.
 *
 * The act a headless caller could not perform: linking is explicit per workspace and nothing does it
 * for you (the provider webhook for an added repository does not project one, and a resync refreshes
 * what is already linked), so a repository created by any means at all stayed invisible to
 * `GET /api/v1/repos` and unusable by `POST /api/v1/services` until a person opened the app's picker.
 *
 * **Idempotent, and answers 200 either way.** Adopting a repository this workspace already links
 * returns the same row rather than refusing, because the caller that most needs this endpoint is a
 * setup script re-running itself, and a 409 there would make every re-run a special case. What the
 * row does report is whether the repository is spoken for (`serviceId`, `linkedElsewhere`), which is
 * the question the caller asks next.
 *
 * A repository the connection cannot reach is a `404` with `details.reason: 'repo_not_reachable'`,
 * never a link to nothing: the two states this endpoint must not blur are "your credential cannot see
 * it" and "it does not exist", and neither is fixed by retrying.
 */
export const linkPublicRepoContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'post',
    pathResolver: () => '/api/v1/repos/link',
    requestBodySchema: linkPublicRepoSchema,
    responsesByStatusCode: { 200: publicRepoSchema, ...errorResponses },
  }),
)

/**
 * Read ONE file from a repository this workspace has linked, at a ref.
 *
 * What it exists for is grading what a run actually COMMITTED, which nothing on this surface could
 * answer: `GET /repos` lists rows, `/repos/available` answers reachability, and
 * `GET /services/:id/spec` serves the one tree the platform understands. Everything else was the
 * agent's own prose, so a caller wanting a real answer had to hold a second VCS credential.
 *
 * **`path` is a QUERY parameter, not the rest of the URL**, which is the one place this deliberately
 * departs from the shape a provider's own API uses. A repo-relative path contains slashes, and a
 * path SEGMENT cannot: OpenAPI 3 path templating does not admit them, so a `.../contents/{path}`
 * would be unrepresentable in the spec the four SDK clients are generated from, and the router would
 * match one segment and 404 everything nested. As a query value it needs one ordinary encoding and
 * every generated client passes it without a special case.
 *
 * `ref` is a branch, tag or commit sha. Omitted, it is passed through omitted, so the PROVIDER
 * resolves the repository's own default branch: the platform's recorded default may be a value it
 * invented for a projection row that carries none, and pinning that would read a branch the
 * repository need not have. The response then reports `ref: null` and the `sha` it did read.
 *
 * Five outcomes a caller branches on, and none of them are folded: `404` with
 * `details.reason: 'repo_not_linked'` for a repository this workspace has not adopted, `404` with
 * `'file_not_found'` for a path the ref does not hold, `422` with `'file_too_large'` for a file past
 * `MAX_REPO_FILE_CHARS` (plus `size` and `limit`) or past the provider's own contents ceiling (plus
 * `limit` alone, since nothing measured it), refused rather than truncated because a shortened
 * answer reads exactly like a shorter file, `422` with `'file_not_text'` (plus `sha`) for bytes that
 * are not UTF-8, and `503` when the deployment's VCS integration is unwired or the provider could
 * not be reached, which is not evidence about the file.
 */
export const getPublicRepoFileContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: withObjectKeys(v.object({ owner: v.string(), name: v.string() })),
    pathResolver: ({ owner, name }) => `/api/v1/repos/${owner}/${name}/contents`,
    requestQuerySchema: v.object({
      path: publicRepoFilePathSchema,
      ref: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(255))),
    }),
    responsesByStatusCode: { 200: publicRepoFileSchema, ...errorResponses },
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

/**
 * Every environment handler this workspace holds, with the secret KEYS each carries and no values.
 *
 * The half that was missing: handlers could be WRITTEN here and never read. A deployment that seeds
 * them programmatically (the documented path for a multi-tenant Node deployment, and the one local
 * mode takes) had no way for a headless caller to confirm the seed landed, so "the backend accepts
 * our credential" and "this workspace has a handler for that backend" collapsed into one
 * unanswerable question. They are different failures with different fixes.
 *
 * It reports every engine, including a `remote-custom` handler for a backend the deployment
 * registered in code, which is why it does not reuse the connect call's own response shape: that one
 * pins `engine: 'kubernetes'` truthfully for a write only ever made with it, and widening a shipped
 * literal would retype a field released clients already narrow on.
 */
export const listPublicEnvironmentConnectionsContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/environments/connections',
    responsesByStatusCode: { 200: publicEnvironmentHandlerListSchema, ...errorResponses },
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
 * The workspace's model catalog, with the flags that decide whether a run can dispatch and which of
 * four unrelated fixes an unrunnable model needs: `available`, `policyBlocked`,
 * `personalSubscription` and `subscriptionConfigured`. Each is documented on
 * `publicWiredModelSchema`, which is where a caller reading the field learns what `null` means.
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
 * The workspace's risk-policy library. The `isDefault` row is the policy a task that pins none
 * resolves, so it is the one that decides whether this caller's runs can land without a person.
 *
 * The id a caller reads here is the one it pins as `riskPolicyId`. It answered at
 * `/api/v1/merge-presets` in 1.41.0, under the name the product renamed away from a month before
 * that release; the correction is a rename in place rather than a dual-served migration because
 * 1.41.0 had no adopters, and `backend/docs/public-api-versions.md` records the exception.
 */
export const listPublicRiskPoliciesContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/risk-policies',
    responsesByStatusCode: { 200: publicRiskPolicyListSchema, ...errorResponses },
  }),
)

/**
 * The workspace's model-preset library, and which one a task pinning none resolves.
 *
 * Beside the risk policies rather than beside the pipelines because the two libraries are siblings:
 * a caller setting a workspace up reads both to learn what its runs will cost and whether they can
 * land. It is what makes `modelPresetId` on task create usable, since an id a caller cannot
 * discover is one it has to hard-code.
 *
 * `admin` follows this file's rule and ADR 0034's reversibility argument, not a claim that a lower
 * rung would be wrong. A `write` key can PIN a preset and cannot LIST one, which is the same gap the
 * public pipeline list was added to close, so relaxing this to `read` is the likely next step. That
 * direction is available; the other one is not. What a refused pin may NOT do is close the gap by
 * accident: the `422` names the id that missed and never the library's contents, or a `write` key
 * would read by typo what this route holds at `admin`.
 */
export const listPublicModelPresetsContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/model-presets',
    responsesByStatusCode: { 200: publicModelPresetListSchema, ...errorResponses },
  }),
)

// ---- the workspace's tracker writeback disposition ---------------------------

/**
 * What this workspace does to a task's linked tracker issue as its pull request progresses.
 *
 * Worth reading before a caller files a ticket-linked task, because it is what decides whether the
 * issue the work came from ever hears about the outcome. It also keeps two states apart that a
 * caller cannot otherwise tell apart: a disposition somebody CHOSE, and the deployment defaults a
 * workspace that has never opened the panel runs on (`updatedAt: null`).
 */
export const getPublicTrackerWritebackContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/tracker/writeback',
    responsesByStatusCode: { 200: publicTrackerWritebackSettingsSchema, ...errorResponses },
  }),
)

/**
 * Change this workspace's writeback disposition, one action at a time if that is all it decides.
 *
 * `admin` on this file's rule, and here the stronger argument applies: it is workspace-wide
 * configuration, so a caller enabling `resolveOnMerge` changes what happens to every other task's
 * ticket on the board too. That is precisely why it MERGES rather than replacing, and why the read
 * beside it reports `updatedAt`: a caller can see it is about to overwrite somebody's choice.
 */
export const updatePublicTrackerWritebackContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'patch',
    pathResolver: () => '/api/v1/tracker/writeback',
    requestBodySchema: updatePublicTrackerWritebackSchema,
    responsesByStatusCode: { 200: publicTrackerWritebackSettingsSchema, ...errorResponses },
  }),
)
