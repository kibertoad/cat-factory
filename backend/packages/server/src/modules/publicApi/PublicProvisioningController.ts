import {
  connectPublicEnvironmentContract,
  getPublicRepoBootstrapContract,
  getPublicRepoFileContract,
  getPublicVcsConnectionContract,
  linkPublicRepoContract,
  listPublicAvailableReposContract,
  listPublicEnvironmentConnectionsContract,
  listPublicEnvironmentManifestTypesContract,
  listPublicModelPresetsContract,
  listPublicRiskPoliciesContract,
  listPublicWiredModelsContract,
  MAX_REPO_FILE_CHARS,
  startPublicRepoBootstrapContract,
  testPublicEnvironmentConnectionContract,
  updatePublicServiceContract,
  UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
  type BootstrapJob,
  type EnvironmentHandlerView,
  type GitHubAvailableRepo,
  type GitHubConnection,
  type InfraHandlerConfig,
  type KubernetesManifestSource,
  type KubernetesUrlSource,
  type ModelCatalog,
  type ModelPreset,
  type PublicAvailableRepo,
  type CustomManifestType,
  type PublicBootstrapJob,
  type PublicCustomManifestType,
  type PublicEnvironmentConnection,
  type PublicEnvironmentConnectionView,
  type PublicEnvironmentHandler,
  type PublicKubernetesManifestSource,
  type PublicKubernetesUrlSource,
  type PublicModelPreset,
  type PublicRiskPolicy,
  type PublicServiceProvisioning,
  type PublicVcsConnection,
  type PublicWiredModel,
  type RiskPolicy,
  type ServiceProvisioning,
  type UpdatePublicServiceInput,
} from '@cat-factory/contracts'
import type {
  BootstrapModule,
  EnvironmentsModule,
  GitHubModule,
  ModelPresetsModule,
  RepoUseByRepoId,
  RiskPoliciesModule,
} from '@cat-factory/orchestration'
import type { PublicApiKeyAuth } from '@cat-factory/integrations'
import {
  NotFoundError,
  RateLimitedError,
  UnavailableError,
  ValidationError,
  VcsApiError,
  VcsBlobTooLargeError,
  individualVendorForModelId,
  isVcsRateLimited,
  type RepoFileContent,
  type RunRepoContext,
} from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv, ServerContainer } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { resolveWorkspaceModelCatalog } from '../models/workspaceCatalog.js'
import { toPublicRepo, toPublicService } from './boardProjection.js'
import { authorizeOrThrow } from './publicApiAuth.js'

// DEPLOYMENT PROVISIONING on `/api/v1`: bringing a workspace from "connected" to "able to run a
// pipeline". Until this existed the first four steps of automating a deployment had no public
// counterpart at all, so a caller that could provision its own keys, enrol its own webhook and file
// its own work still had to open a browser to have a repository to file it against.
//
// Its own controller rather than more of `PublicBoardController`: that file is about the shape of a
// board an integration drives, where everything here happens BEFORE there is a board to shape, and
// it is the only place on this surface that accepts an infrastructure credential.
//
// Five rules, each enforced below rather than merely intended:
//
//  1. **Every call delegates to the SAME service method the SPA's own controller calls.** A guard
//     (the bootstrap preflight that refuses a non-empty repository, the monorepo subdirectory rules,
//     the engine's own apiserver probe) cannot differ by which door the request came through.
//  2. **Public shapes are PROJECTIONS both ways.** The internal shapes these map to are internal
//     wire shapes, which this repo evolves without migrations; `/api/v1` is frozen. The mappers
//     here are the seam that lets both of those stay true, so an internal field rename is a diff in
//     this file rather than a silent public break. See `contracts/src/public-provisioning.ts`.
//  3. **A secret goes IN and never comes back.** The two connection calls accept a secret bundle
//     because reaching an apiserver needs one; every response projects the KEYS and no value.
//  4. **Refusals THROW `DomainError`s**, so `handleError` produces the one wire envelope and a
//     caller gets the `details.reason` it branches on. `authorizeOrThrow` is the auth-gate form of
//     the same rule.
//  5. **A read that cannot be answered is a 503 naming what is unwired**, never an empty success. A
//     caller reading "no models" and "models not configured" the same way is exactly the confusion
//     these reads exist to remove.

/** The bootstrap module, or the 503 naming what this deployment has not wired. */
function requireBootstrap<E extends AppEnv>(c: Context<E>): BootstrapModule {
  return requireCapability(c.get('container').bootstrap, 'Repo bootstrap is not configured')
}

/**
 * The module that can LINK a repository, or the 503 naming what is missing.
 *
 * Its own accessor rather than {@link readVcsConnection}, because the two answer different questions
 * and a GitLab-only facade is exactly where they diverge: that one reads a CONNECTION, which the PAT
 * service can hold on its own, while linking needs the sync service, which only the `github` module
 * builds. So a workspace can truthfully report a connection here and still have nowhere to project a
 * repository into, and a message borrowed from the connection read would tell an operator to connect
 * something they have already connected.
 */
function requireRepoLinking<E extends AppEnv>(c: Context<E>): GitHubModule {
  return requireCapability(
    c.get('container').github,
    'Adopting a repository needs the source-control module this deployment has not wired',
    'repo_linking_unwired',
  )
}

/** The environments module, or the 503 naming what this deployment has not wired. */
function requireEnvironments<E extends AppEnv>(c: Context<E>): EnvironmentsModule {
  return requireCapability(
    c.get('container').environments,
    'Environment integration is not configured',
  )
}

/**
 * The workspace's source-control connection, whichever seam holds it, or the 503 when this
 * deployment wires no source control at all.
 *
 * Two seams and not one, because a GitLab-only deployment builds no `github` module: that module
 * requires the App's webhook verifier, which is App-specific (a GitLab workspace ingests through
 * the neutral `/vcs/:provider/webhooks` route instead), so it is absent exactly when the PAT
 * connect service is the thing holding the connection. Reading only the module answered a
 * provider-neutral question with "source control is not configured" at a workspace that plainly
 * had a connection, and the acceptance preflight then reported an unknown probe failure for a row
 * it could read.
 *
 * The module is preferred when present, because with BOTH wired it is the one that routes an
 * installation to its provider's client; the PAT service is the fallback, not a second opinion.
 */
export async function readVcsConnection(
  container: ServerContainer,
  workspaceId: string,
): Promise<GitHubConnection | null> {
  const github: GitHubModule | undefined = container.github
  if (github) return github.installationService.getConnection(workspaceId)
  const pat = requireCapability(
    container.vcsConnectionService,
    'Source-control integration is not configured',
  )
  return pat.getConnection(workspaceId)
}

/**
 * Whether this deployment serves models a read resolving no user cannot ENUMERATE: per-user
 * locally-run endpoints, which live on one developer's own machine.
 *
 * A named predicate over a TYPED container rather than an `!== undefined` in the route, because
 * this is the one optional-capability read on this surface whose answer is DATA rather than a
 * refusal: it is reported to the caller, so it has to be as legible as the `require*` accessors
 * next to it, and the field it names has to fail to compile if it is ever renamed.
 *
 * Deliberately NOT widened to `personalSubscriptions`. A personal subscription's models are in this
 * catalog already (listed as unavailable), so nothing about them is missing from the answer — what
 * is missing is the CREDENTIAL read that would have judged them, which is a per-model fact and is
 * reported per model as `userScoped`. Folding it in here instead would make the flag true on every
 * deployment that merely has `ENCRYPTION_KEY` set, whether or not a single personal subscription
 * exists, and a flag that is always true has stopped answering its question: it would say "this
 * build supports withholding" where a caller reads "something was withheld from you".
 */
function servesUserScopedModels(container: ServerContainer): boolean {
  return container.localModelEndpoints !== undefined
}

/**
 * The subscription vendors the person behind this key holds a live personal credential for, or
 * `undefined` when there is no person to ask about.
 *
 * Two things make this answerable at all, and both are worth stating because the last attempt at
 * this question concluded it was not. Whether a credential EXISTS is a row lookup: the token is
 * sealed under the owner's personal password, which opens it and which nothing here holds or wants,
 * so reporting existence costs no unlock and reveals no secret. And an unbound key does have a
 * person: its MINTER, which is exactly who the remedy names ("mint the token again with Runs as set
 * to yourself"). Reading it is provenance used to DESCRIBE, never to authorize: `available` is
 * still resolved under `actsAsUserId` alone, so an unbound key is told its subscription is there and
 * still cannot spend it. What that trades, and what contains it, is stated on `subscriptionConfigured`.
 *
 * That closes the gap this surface actually shipped with. A system token was told a model on a
 * subscription it owns is unavailable, with no way to tell that from a model nobody configured, and
 * the only route to the fix was guessing it.
 *
 * Deliberately NOT shared with the set the capability resolver builds for the same request, even
 * though a BOUND key makes the two identical. They are questions about potentially DIFFERENT people
 * (this one falls back to the minter, that one never does), and handing this answer to the resolver
 * would let an unbound key's availability resolve off somebody else's credential, which is the one
 * thing separating a description from an authorization here. The two run concurrently instead, so
 * the overlap costs a query rather than a round trip.
 */
async function personalSubscriptionVendors(
  container: ServerContainer,
  auth: PublicApiKeyAuth,
): Promise<ReadonlySet<string> | undefined> {
  const owner = auth.actsAsUserId ?? auth.createdByUserId
  if (!owner || !container.personalSubscriptions) return undefined
  return container.personalSubscriptions.liveVendors(owner)
}

/**
 * The risk-policy module, or the 503 — carrying the SAME `details.reason` a refused pin does.
 *
 * One deployment fact ("this facade wired no risk-policy repository") reaches a caller by two
 * routes: this list, and the `422`/`503` a task pinning one gets back. Answering the discovery
 * call with a bare `unavailable` and the pin with a reason would make a client parse prose on
 * whichever it happened to hit first.
 */
function requireRiskPolicies<E extends AppEnv>(c: Context<E>): RiskPoliciesModule {
  return requireCapability(
    c.get('container').riskPolicies,
    'Risk policies are not configured',
    'risk_policies_unwired',
  )
}

/** The model-preset module, or the 503; same pairing as {@link requireRiskPolicies}. */
function requireModelPresets<E extends AppEnv>(c: Context<E>): ModelPresetsModule {
  return requireCapability(
    c.get('container').modelPresets,
    'Model presets are not configured',
    'model_presets_unwired',
  )
}

/**
 * The internal engine a public `kubernetes` connection registers as.
 *
 * The internal vocabulary splits Kubernetes in two (`local-k3s` and `remote-kubernetes`), and that
 * split is deliberately NOT a public fact: one backend serves both (`kubernetes-environment-backend`
 * declares `engines: () => ['local-k3s', 'remote-kubernetes']`), both lower to the same provision
 * type and the same provision config, so which name a handler is stored under is not observable in
 * anything a run does. Exposing the choice would be asking a caller to make a decision that changes
 * nothing, and freezing it onto a surface that can never drop it.
 */
const KUBERNETES_ENGINE = 'remote-kubernetes' as const

export function publicProvisioningController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  registerBootstrapRoutes(app)
  registerRepoAdoptionRoutes(app)
  registerEnvironmentRoutes(app)
  registerServiceRoutes(app)
  registerWiringRoutes(app)
  return app
}

// ---- repo bootstrap ---------------------------------------------------------

/**
 * Project a bootstrap run onto the wire.
 *
 * `blockId` becomes `serviceId` because that is what this surface calls a service frame everywhere
 * else, and a caller joins it straight onto `/api/v1/services/:serviceId/tasks`.
 *
 * The structured failure is FLATTENED into its three human-readable parts rather than published as a
 * nested object: the kind (whether a retry could help), the detail, and the hint. All three are
 * prose the platform wrote for whoever is reading a failed run; what is left behind is the
 * remainder whose shape is genuinely internal. See the schema for the full accounting.
 */
export function toPublicBootstrapJob(job: BootstrapJob): PublicBootstrapJob {
  return {
    jobId: job.id,
    status: job.status,
    repoName: job.repoName,
    repoOwner: job.repoOwner,
    repoUrl: job.repoUrl,
    prUrl: job.prUrl,
    delivery: job.delivery,
    serviceId: job.blockId,
    progress: job.subtasks,
    error: job.error,
    failureKind: job.failure?.kind ?? null,
    failureDetail: job.failure?.detail ?? null,
    failureHint: job.failure?.hint ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function registerBootstrapRoutes(app: Hono<AppEnv>): void {
  buildHonoRoute(app, startPublicRepoBootstrapContract, async (c) => {
    const auth = await authorizeOrThrow(c, startPublicRepoBootstrapContract.minScope)
    const bootstrap = requireBootstrap(c)
    // Wired but unable to act is a PREDICATE, not an absent value, so it throws directly rather
    // than through the capability accessor: the same refusal the SPA's own route raises.
    if (!bootstrap.service.canBootstrap) {
      throw new UnavailableError(
        'Repo bootstrapping needs the source-control connection and the implementation container ' +
          'to be configured',
        'bootstrap_not_dispatchable',
      )
    }
    const body = c.req.valid('json')
    // The omitted-value rules live here rather than as valibot defaults on the request schema: a
    // schema default is ambiguous for a generator emitting a request type and a response type from
    // one shape, so the contract states each default in prose and this is where it is applied.
    const job = await bootstrap.service.bootstrap(auth.workspaceId, {
      repoName: body.repoName,
      ...(body.type ? { type: body.type } : {}),
      description: body.description ?? '',
      // Private unless the caller says otherwise: the safe default for a repository this creates on
      // someone's account, and the one the SPA's own form offers.
      private: body.private ?? true,
      instructions: body.instructions ?? '',
      // Omitted means "scaffold from the brief alone", which the internal input spells as an
      // explicit null rather than an absent key.
      referenceArchitectureId: body.referenceArchitectureId ?? null,
    })
    return c.json(toPublicBootstrapJob(job), 201)
  })

  buildHonoRoute(app, getPublicRepoBootstrapContract, async (c) => {
    const auth = await authorizeOrThrow(c, getPublicRepoBootstrapContract.minScope)
    const bootstrap = requireBootstrap(c)
    const { jobId } = c.req.valid('param')
    // Scoped to the key's own workspace by the service, so another workspace's job is absent here
    // rather than forbidden: the same 404-hides-everything rule the rest of this surface follows.
    // The service raises that 404 itself, carrying `bootstrap_job_not_found`; a local `if (!job)`
    // beside it would be dead code, and the reason a caller branches on would ship from nowhere.
    return c.json(
      toPublicBootstrapJob(await bootstrap.service.getJob(auth.workspaceId, jobId)),
      200,
    )
  })
}

/**
 * Project one reachable repository onto the wire.
 *
 * Rebuilt field by field, like every other mapper here: the internal shape carries `githubId` (the
 * provider-specific name the neutral surface calls `repoId`) and spells two of its booleans as
 * optional-with-a-default, which a frozen surface may not. Absent becomes the stated value here so a
 * caller never has to distinguish a missing key from a false one.
 *
 * Whether the repository is SPOKEN FOR comes in from `use` rather than off the row, because it is a
 * board fact rather than a provider one: the same account-scoped judgement `GET /api/v1/repos`
 * publishes, so the two reads cannot come to disagree about whether a repository is free.
 */
export function toPublicAvailableRepo(
  repo: GitHubAvailableRepo,
  use: RepoUseByRepoId,
): PublicAvailableRepo {
  // A repository no service in the account holds is free, and the absence of a verdict IS that
  // answer rather than a missing one: the map is built from these very ids, so the only way a row
  // is not in it is that nothing claims it.
  const held = use.get(repo.githubId)
  return {
    repoId: repo.githubId,
    // Absent on a row from a provider-agnostic path that predates the column, which the platform
    // reads as `github` everywhere else.
    provider: repo.provider ?? 'github',
    owner: repo.owner,
    name: repo.name,
    // Empty rather than null, matching `GET /api/v1/repos`: a caller reads it to name a base, and
    // there is nothing here that could invent one.
    defaultBranch: repo.defaultBranch ?? '',
    private: repo.private,
    linked: repo.linked,
    monorepo: repo.isMonorepo === true,
    serviceId: held?.serviceBlockId ?? null,
    linkedElsewhere: held?.linkedElsewhere === true,
    personal: repo.personal === true,
  }
}

/**
 * Re-raise a PROVIDER failure as the refusal it actually is, or propagate it untouched.
 *
 * The two adopt routes are the only ones on this surface that reach the provider on the request path,
 * so they are the only ones that can fail for a reason that is neither the caller's fault nor the
 * platform's: a token the provider has revoked, or a rate limit. Left bare, both arrive as a `500`
 * `internal`, which tells a headless caller to report a platform fault and file a bug about a
 * credential only they can replace. It is also the difference between two answers a setup script acts
 * on differently: a rejected credential is not "your repository does not exist", and a rate limit is
 * the one failure here that IS worth retrying.
 *
 * Anything else propagates. A provider that is down, or a bug in this platform, is a `500`, and
 * dressing either as a connection problem would send an operator to re-mint a working token.
 *
 * Keyed on kernel's provider-neutral `VcsApiError` rather than on the GitHub class: a workspace
 * connected to GitLab reaches these routes through the same service and throws `GitLabApiError`, so
 * a GitHub-only check would answer a revoked GitLab token with the `500` this function exists to
 * prevent, on the deployment least able to tell that is what happened.
 */
export function asVcsRefusal(error: unknown): unknown {
  if (!(error instanceof VcsApiError)) return error
  const status = error.status
  // A PRIMARY rate-limit exhaustion is reported as a 403, so the flag decides as well as the status:
  // a permission denial and an exhausted budget are the same number from GitHub.
  if (isVcsRateLimited(error)) {
    return new RateLimitedError(
      "The source-control provider is rate-limiting this workspace's credential. Retry later.",
      'vcs_rate_limited',
    )
  }
  if (status === 401 || status === 403) {
    return new UnavailableError(
      "The source-control provider rejected this workspace's credential, so what it can reach " +
        'cannot be read. Re-connect the workspace (an app installation may have been removed, a ' +
        'token revoked or expired) and try again.',
      'vcs_credential_rejected',
    )
  }
  return error
}

/** Run one provider-reaching call, mapping its failures through {@link asVcsRefusal}. */
async function throughVcs<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw asVcsRefusal(error)
  }
}

/**
 * Adopting a repository that already exists: what it can reach, and linking one by name.
 *
 * Both routes go through the SAME sync-service methods the app's own repo picker calls, which is what
 * makes an adopted repository indistinguishable from one a person ticked: the projection row, its
 * deep sync and the cache invalidation are one code path rather than two.
 */
function registerRepoAdoptionRoutes(app: Hono<AppEnv>): void {
  // What the connection can REACH, linked or not. The read that makes an absent repository
  // diagnosable rather than merely absent, since `GET /api/v1/repos` answers identically for a
  // repository that does not exist and one nobody has linked yet.
  buildHonoRoute(app, listPublicAvailableReposContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicAvailableReposContract.minScope)
    const github = requireRepoLinking(c)
    const { q } = c.req.valid('query')
    // Through the same provider-refusal mapping as the link beside it: this read reaches the
    // provider on the request path too, so a revoked credential or a rate limit here is the same
    // fact, and answering one of them as a `500` sends a caller to file a platform bug about a
    // token only they can replace.
    const { repos, truncated } = await throughVcs(() =>
      // No viewer token is passed, and that is not an omission: a key authenticates as the
      // WORKSPACE, so the only repositories in scope are the ones its connection reaches.
      // `personal` therefore reports false throughout, which the contract states rather than
      // leaving a caller to infer from a field that never varies.
      github.syncService.listAvailableRepos(auth.workspaceId, q === undefined ? {} : { q }),
    )
    // Whether each is already spoken for, from the SAME account-scoped judgement `GET /api/v1/repos`
    // publishes and `POST /api/v1/services` decides on. Derived here rather than in the sync service
    // because it is a board fact, not a provider one, and one batched read for the whole page.
    const use = await c.get('container').boardService.describeRepoUse(
      auth.workspaceId,
      repos.map((repo) => repo.githubId),
    )
    return c.json({ repos: repos.map((repo) => toPublicAvailableRepo(repo, use)), truncated }, 200)
  })

  // Adopt one by name, so a headless setup never has to open the app. Idempotent: a repository this
  // workspace already links returns its row.
  buildHonoRoute(app, linkPublicRepoContract, async (c) => {
    const auth = await authorizeOrThrow(c, linkPublicRepoContract.minScope)
    const github = requireRepoLinking(c)
    const { owner, name } = c.req.valid('json')
    const linked = await throughVcs(() =>
      github.syncService.linkRepoBySlug(auth.workspaceId, owner, name),
    )
    // One reason for two causes, because this read genuinely cannot tell them apart: a repository
    // that does not exist and one the workspace's credential is not granted are the same 404 from the
    // provider. The contract names both, so a caller renders the pair rather than picking one.
    if (!linked) {
      throw new NotFoundError('repository', `${owner}/${name}`, { reason: 'repo_not_reachable' })
    }
    // Projected from `listRepoOptions` rather than from the row just linked, so the adopt answers in
    // exactly the shape and with exactly the judgements `GET /api/v1/repos` serves: whether the
    // repository already backs a service here, and whether one is homed on a board this key cannot
    // address. Deriving those here would be a second opinion on the question the caller asks next.
    const options = await c.get('container').boardService.listRepoOptions(auth.workspaceId)
    const adopted = options.find((option) => option.repo.githubId === linked.githubId)
    if (!adopted) {
      // Unreachable by construction (the link wrote the projection row this list reads), so it is a
      // refusal rather than a `!`: the alternative renders a half-built row into the response whose
      // whole job is to hand back an id the next call uses.
      throw new NotFoundError('repository', `${owner}/${name}`, { reason: 'repo_not_projected' })
    }
    return c.json(toPublicRepo(adopted), 200)
  })

  registerRepoFileRoute(app)
}

/**
 * ONE file out of a linked repository, so a caller can grade what a run COMMITTED.
 *
 * It closes the loop on everything else this surface can start. A caller could create a repository,
 * adopt one, file work against it and watch a run merge, and then had nothing to read but the
 * agent's own final reply, which is asserting on model prose: swap the model and it goes red having
 * found nothing wrong. The only real alternative was a SECOND VCS credential in the caller's config,
 * with its own scopes to get right, for data the workspace's own connection already reads.
 *
 * Five outcomes, kept apart because each takes a different action, and because folding any of them
 * onto "no such file" is the same mistake `PublicSpecController` documents at length: a repository
 * that answers nothing and a file that is genuinely absent look identical from a provider. Two of the
 * five are what {@link readGradableFile} exists to name.
 */
function registerRepoFileRoute(app: Hono<AppEnv>): void {
  buildHonoRoute(app, getPublicRepoFileContract, async (c) => {
    const auth = await authorizeOrThrow(c, getPublicRepoFileContract.minScope)
    const resolve = requireCapability(
      c.get('container').resolveRepoFilesForCoords,
      'No version-control integration is configured for this deployment',
      'vcs_not_configured',
    )
    const { owner, name } = c.req.valid('param')
    const { path, ref } = c.req.valid('query')
    // Resolved against the workspace's PROJECTED repos, so this reads only what this workspace has
    // LINKED. A repository the deployment's credential could reach and nobody adopted is absent
    // here exactly as it is from `GET /api/v1/repos`, which is what stops the endpoint becoming a
    // way to read any repository an installation happens to cover.
    const context = await resolve(auth.workspaceId, { owner, repo: name })
    if (!context) {
      throw new NotFoundError('repository', `${owner}/${name}`, { reason: 'repo_not_linked' })
    }
    // `ref` is passed through EXACTLY as the request gave it, absent included, because the port
    // resolves the repository's own default branch for an omitted one. `context.baseBranch` is the
    // wrong value to substitute: `makeResolveRepoFilesForCoords` INVENTS `main` for a projection row
    // carrying no default branch, so a repository whose default is `master` would be read at a
    // branch it does not have and answer `file_not_found` for a file that is right there, while the
    // response named the invented branch as the thing graded.
    const at = `${owner}/${name}:${path}`
    const file = await readGradableFile(context.repo, at, path, ref)
    if (!file) {
      throw new NotFoundError('file', `${at}@${ref ?? 'the default branch'}`, {
        reason: 'file_not_found',
      })
    }
    if (file.content.length > MAX_REPO_FILE_CHARS) {
      // REFUSED, never truncated. A caller reading a file to grade what an agent committed is
      // joining on its exact bytes, and a silently shortened answer is indistinguishable from an
      // agent that wrote a shorter file. The size and the limit ride `details` because those are
      // facts a caller can act on where a truncation is not.
      //
      // A 422 and not a 413: `Content Too Large` is a statement about the REQUEST entity, and this
      // request is perfectly well formed. The status class is "structurally valid, refused by a
      // domain rule", which is the same reading `resolveRepoTarget` takes for an unlinked service,
      // and the machine-readable cause is `details.reason` as it is everywhere else on this surface.
      throw new ValidationError(
        `${at} is ${file.content.length} characters, past the ${MAX_REPO_FILE_CHARS} this read ` +
          `answers with`,
        { reason: 'file_too_large', size: file.content.length, limit: MAX_REPO_FILE_CHARS },
      )
    }
    return c.json(
      { owner, name, path, ref: ref ?? null, sha: file.sha, content: file.content },
      200,
    )
  })
}

/**
 * Read one file, turning the two answers only this layer can name into the refusals it documents.
 *
 * **A blob past the PROVIDER's own contents ceiling is the same refusal as one past ours.** GitHub
 * reports it as a `403`, which {@link asVcsRefusal} would otherwise read as a rejected credential,
 * so an operator whose lockfile is 1.4 MB would be told to re-mint a token that works. The adapter
 * names the fact (`VcsBlobTooLargeError`) and this maps it onto `file_too_large` with the provider's
 * limit and NO size, because nothing here measured one.
 *
 * **Bytes that are not UTF-8 are refused rather than answered.** The decode is lossy for a PNG, a
 * tarball or a Latin-1 source file, and handing back replacement characters under a field documented
 * as the file's content is the same lie the truncation above refuses to tell: a caller comparing
 * against its own copy sees a mismatch it cannot attribute. The `sha` rides the refusal, so the
 * byte-exact join a grader wanted is still available.
 *
 * Anything else is a fact about the provider and goes through {@link asVcsRefusal} unchanged.
 */
export async function readGradableFile(
  repo: RunRepoContext['repo'],
  at: string,
  path: string,
  ref: string | undefined,
): Promise<RepoFileContent | null> {
  let file: RepoFileContent | null
  try {
    file = await repo.getFile(path, ref)
  } catch (error) {
    if (error instanceof VcsBlobTooLargeError) {
      throw new ValidationError(
        `${at} is past the ${error.limitBytes} bytes ${error.provider} will serve through its ` +
          `contents API, so this read cannot answer with it`,
        { reason: 'file_too_large', limit: error.limitBytes },
      )
    }
    throw asVcsRefusal(error)
  }
  if (file?.lossy) {
    throw new ValidationError(
      `${at} is not UTF-8 text, so this read cannot answer with its content; its blob sha is ` +
        `${file.sha}`,
      { reason: 'file_not_text', sha: file.sha },
    )
  }
  return file
}

// ---- the environment connection (the ENGINE half) ---------------------------

/**
 * Lower a public URL source onto the internal one.
 *
 * Rebuilt member by member rather than passed through, because the two are separate types by
 * design (see the contracts header): the internal variant is free to gain a source or rename a
 * field, and this switch is where that stops being a silent public change. The `never` default is
 * what makes it stop at COMPILE time.
 */
function toKubernetesUrlSource(url: PublicKubernetesUrlSource): KubernetesUrlSource {
  switch (url.source) {
    case 'ingressTemplate':
      return {
        source: 'ingressTemplate',
        hostTemplate: url.hostTemplate,
        ...(url.port === undefined ? {} : { port: url.port }),
        ...scheme(url.scheme),
      }
    case 'ingressStatus':
      return {
        source: 'ingressStatus',
        ...(url.ingressName === undefined ? {} : { ingressName: url.ingressName }),
        ...scheme(url.scheme),
      }
    case 'serviceStatus':
      return {
        source: 'serviceStatus',
        serviceName: url.serviceName,
        ...(url.port === undefined ? {} : { port: url.port }),
        ...scheme(url.scheme),
      }
    case 'gatewayStatus':
      return {
        source: 'gatewayStatus',
        ...(url.gatewayName === undefined ? {} : { gatewayName: url.gatewayName }),
        ...scheme(url.scheme),
      }
    case 'httpRouteStatus':
      return {
        source: 'httpRouteStatus',
        ...(url.httpRouteName === undefined ? {} : { httpRouteName: url.httpRouteName }),
        ...scheme(url.scheme),
      }
    default:
      return unreachableSource(url)
  }
}

/** An omitted `scheme` stays omitted, so the engine's own default decides rather than this mapper. */
function scheme(value: 'http' | 'https' | undefined): { scheme?: 'http' | 'https' } {
  return value === undefined ? {} : { scheme: value }
}

/** The compile-time half of the projection: a new public member has to be lowered explicitly. */
function unreachableSource(value: never): never {
  throw new Error(`unmapped public Kubernetes URL source: ${JSON.stringify(value)}`)
}

/**
 * Lower a public manifest source onto the internal one, for the same reason and with the same
 * exhaustiveness as the URL source above.
 */
function toKubernetesManifestSource(
  source: PublicKubernetesManifestSource,
): KubernetesManifestSource {
  const renderer = source.renderer === undefined ? {} : { renderer: source.renderer }
  return source.type === 'colocated'
    ? { type: 'colocated', path: source.path, ...renderer }
    : {
        type: 'separate',
        repo: source.repo,
        ...(source.ref === undefined ? {} : { ref: source.ref }),
        path: source.path,
        ...renderer,
      }
}

/** Lower a public connection onto the internal per-engine handler config. */
function toInfraHandlerConfig(connection: PublicEnvironmentConnection): InfraHandlerConfig {
  return {
    engine: KUBERNETES_ENGINE,
    kubernetes: { ...connection.kubernetes, url: toKubernetesUrlSource(connection.kubernetes.url) },
  }
}

/**
 * Project a registered handler back, with its secret KEYS and none of their values.
 *
 * `baseUrl` is the connection's own endpoint, which for a Kubernetes engine is the apiserver, so it
 * is reported under the name the caller supplied it as rather than the engine's generic one.
 *
 * The CONNECT response only, which is why `engine` can be the literal: this surface registers
 * kubernetes and nothing else, so it is true of every handler this call can produce. The LIST is a
 * different question and takes {@link toPublicHandler}.
 */
function toPublicConnectionView(view: EnvironmentHandlerView): PublicEnvironmentConnectionView {
  return {
    provisionType: view.provisionType,
    engine: 'kubernetes',
    label: view.label,
    apiServerUrl: view.baseUrl,
    secretKeys: view.secretKeys,
  }
}

/**
 * Project a handler for the LIST, whatever engine services it.
 *
 * `engine` and `backendKind` are open strings here rather than the connect view's literal, because
 * this read reports handlers the deployment SEEDED from its composition root, and a deployment may
 * register an environment backend of its own: the whole point of the registry. Reporting one as
 * `kubernetes` would be the coercion the board projection refuses next door, and omitting it would
 * make a seeded handler indistinguishable from an absent one, which is the state this read exists to
 * make checkable.
 *
 * `endpoint` and not `apiServerUrl`: the Kubernetes noun is false of every other engine, and stating
 * it anyway is what sends an operator whose environment is a VM looking for an apiserver.
 *
 * BOTH manifest-id fields are reported, because the engine's own resolution
 * (`resolveInfraHandler` → `matchesCustom`) matches a service's pinned `manifestId` against EITHER,
 * and the two ways of registering a handler each set only one: a deployment SEEDING one keys it with
 * `manifestId`, while a `remote-custom` connection declares `acceptsManifestId`. Publishing only the
 * second made the commonest seed shape read as a handler serving nothing, so a setup script checking
 * that its own seed landed found no entry naming it while a run against it resolved fine.
 *
 * No `config`, though `EnvironmentHandlerView` carries one for the app's connect-form prefill: it is
 * the internal per-engine bag, deliberately open, and this surface may not freeze it (ADR 0034).
 */
export function toPublicHandler(view: EnvironmentHandlerView): PublicEnvironmentHandler {
  return {
    provisionType: view.provisionType,
    manifestId: view.manifestId,
    acceptsManifestId: view.acceptsManifestId,
    engine: view.engine,
    backendKind: view.backendKind,
    label: view.label,
    endpoint: view.baseUrl,
    secretKeys: view.secretKeys,
    connectedAt: view.connectedAt,
  }
}

function registerEnvironmentRoutes(app: Hono<AppEnv>): void {
  // Probe without persisting. `ok: false` is an ANSWER (the cluster refused the token), so it is a
  // 200 carrying the verdict rather than an error: a caller distinguishes "the cluster said no"
  // from "the request was malformed", and only one of those is a 4xx.
  buildHonoRoute(app, testPublicEnvironmentConnectionContract, async (c) => {
    const auth = await authorizeOrThrow(c, testPublicEnvironmentConnectionContract.minScope)
    const environments = requireEnvironments(c)
    const { connection, secrets } = c.req.valid('json')
    const result = await environments.connectionService.testHandler(auth.workspaceId, {
      config: toInfraHandlerConfig(connection),
      // An omitted bundle is an EMPTY one, not an absent argument: probing a cluster with no
      // credential is a legitimate question (does it accept anonymous reads), and the engine's own
      // probe is what answers it.
      secrets: secrets ?? {},
    })
    return c.json({ ok: result.ok, message: result.message ?? null }, 200)
  })

  buildHonoRoute(app, connectPublicEnvironmentContract, async (c) => {
    const auth = await authorizeOrThrow(c, connectPublicEnvironmentContract.minScope)
    const environments = requireEnvironments(c)
    const { connection, secrets } = c.req.valid('json')
    const view = await environments.connectionService.registerHandler(auth.workspaceId, {
      // Derived rather than accepted: for a Kubernetes engine the provision type it serves is a
      // fact about the engine, so asking a caller to restate it only creates a pair that can
      // disagree.
      provisionType: 'kubernetes',
      config: toInfraHandlerConfig(connection),
      secrets,
    })
    return c.json(toPublicConnectionView(view), 201)
  })

  // What a `custom` pin may NAME, both tiers in one list: the manifest types this deployment
  // registers in code and the rows this workspace defines. The service method is the SAME one the
  // app's own inspector reads, so a caller checking an id before it pins cannot be told something
  // different from what the engine will resolve.
  //
  // It exists because nothing checks a pin on the way in. `publicManifestIdSchema` checks a string
  // format, so an id no handler serves is stored and fails at the `deployer` step of a run already
  // paid for; refusing it at the write would narrow what a live integration may send (ADR 0034).
  buildHonoRoute(app, listPublicEnvironmentManifestTypesContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicEnvironmentManifestTypesContract.minScope)
    const environments = requireEnvironments(c)
    const types = await environments.connectionService.listCustomTypes(auth.workspaceId)
    const manifestTypes = types.map(toPublicManifestType).sort(byManifestId)
    return c.json({ manifestTypes }, 200)
  })

  // The read half. Ordered so a caller diffing two workspaces (or its own setup before and after)
  // compares two stable lists rather than two insertion orders.
  buildHonoRoute(app, listPublicEnvironmentConnectionsContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicEnvironmentConnectionsContract.minScope)
    const environments = requireEnvironments(c)
    const handlers = await environments.connectionService.listHandlers(auth.workspaceId)
    const connections = handlers.map(toPublicHandler).sort(byHandlerIdentity)
    return c.json({ connections }, 200)
  })
}

/**
 * Project one catalog entry onto what a caller pinning an id can act on.
 *
 * `fixerPrompt` and `acceptsInputHint` stay off it deliberately: the first is internal text this
 * repo rewrites freely, and freezing either on a surface that may never be reshaped buys a caller
 * nothing. `defaultManifestPath` is published because it is the value a pin that names no
 * `manifestPath` will actually deploy from, and `null` says the type declares none rather than
 * that the field is missing.
 */
export function toPublicManifestType(type: CustomManifestType): PublicCustomManifestType {
  return {
    manifestId: type.manifestId,
    label: type.label,
    source: type.source,
    defaultManifestPath: type.defaultManifestPath ?? null,
  }
}

/** By the id a pin names, comparing code units for the reason {@link byHandlerIdentity} gives. */
export function byManifestId(
  left: PublicCustomManifestType,
  right: PublicCustomManifestType,
): number {
  return compareCodeUnits(left.manifestId, right.manifestId)
}

/**
 * Order handlers by what IDENTIFIES one, comparing code units rather than collating.
 *
 * `localeCompare` is ICU- and locale-dependent, so the same set of handlers can serialise in one
 * order from a workerd isolate and in another from a Node build with a different ICU: precisely the
 * spurious diff the ordering was added to prevent. A code-unit comparison answers the same everywhere,
 * which is what a wire ordering needs.
 *
 * Both manifest ids join the key, since two `custom` handlers keyed to different manifests are
 * otherwise equal here. A handler that ties on all four keys keeps its position from the repository
 * read (the sort is stable), which is the honest fallback: nothing published distinguishes them.
 */
export function byHandlerIdentity(
  left: PublicEnvironmentHandler,
  right: PublicEnvironmentHandler,
): number {
  return (
    compareCodeUnits(left.provisionType, right.provisionType) ||
    compareCodeUnits(left.manifestId, right.manifestId) ||
    compareCodeUnits(left.acceptsManifestId, right.acceptsManifestId) ||
    compareCodeUnits(left.label, right.label)
  )
}

/** An absent id sorts first, which is the only ordering a null can honestly take. */
function compareCodeUnits(left: string | null, right: string | null): number {
  const a = left ?? ''
  const b = right ?? ''
  if (a === b) return 0
  return a < b ? -1 : 1
}

// ---- a service's provisioning (the SOURCE half) -----------------------------

function registerServiceRoutes(app: Hono<AppEnv>): void {
  buildHonoRoute(app, updatePublicServiceContract, async (c) => {
    const auth = await authorizeOrThrow(c, updatePublicServiceContract.minScope)
    const container = c.get('container')
    const { serviceId } = c.req.valid('param')
    // Resolved through the public board read, so a frame in another workspace, a task id, or a
    // headless run anchor is ABSENT rather than forbidden, exactly as every other read here.
    const service = await container.boardService.getService(auth.workspaceId, serviceId)
    if (!service) throw new NotFoundError('Service', serviceId, { reason: 'service_not_found' })
    const block = await container.boardService.updateBlock(
      auth.workspaceId,
      serviceId,
      toBlockPatch(c.req.valid('json'), service.provisioning),
      // Unattributed by the same reading a headless start gets (ADR 0037): an API key holds
      // scopes, not a workspace tier.
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    return c.json(toPublicService(block), 200)
  })
}

/**
 * Lower a public service patch onto the board patch.
 *
 * An omitted key is left OUT rather than written as `undefined`: `updateBlock` patches only the
 * keys present, so spreading an absent `provisioning` through would clear the stored one and
 * silently un-deploy a service whose title was being corrected.
 */
export function toBlockPatch(
  input: UpdatePublicServiceInput,
  stored: ServiceProvisioning | undefined,
): {
  title?: string
  description?: string
  provisioning?: ServiceProvisioning
} {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.provisioning === undefined
      ? {}
      : { provisioning: mergeProvisioning(input.provisioning, stored) }),
  }
}

/**
 * Overlay a public provisioning patch onto what the service already declares.
 *
 * `provisioning` is ONE JSON column and `updateBlock` REPLACES it wholesale, where this surface
 * publishes a few of its dozen fields. Writing just those would therefore delete every field the
 * public shape cannot express: a Kubernetes service's `images`, `secretInjections` and
 * `helmReleases`, authored in the app by someone who is not the caller. The next deploy would
 * render manifests with no image overrides and no Secrets, which is the "empty environment that
 * looks like a cluster fault" failure one field deeper, and the caller that caused it was only
 * correcting a manifest path.
 *
 * A patch that CHANGES the provision type replaces instead of overlaying: the stored remainder
 * belongs to the type being left behind, so carrying it forward would attach one engine's
 * configuration to another.
 *
 * Exhaustive over the public variant through a `never`, so a member added there cannot reach the
 * stored column as an unlowered shape.
 */
function mergeProvisioning(
  patch: PublicServiceProvisioning,
  stored: ServiceProvisioning | undefined,
): ServiceProvisioning {
  const base = stored?.type === patch.type ? stored : undefined
  switch (patch.type) {
    case 'infraless':
      // Taking the pin back, and the ONE member that does not overlay: `...base` is deliberately
      // not spread even when the stored column is already `infraless`. The whole bag belongs to
      // the engine being left behind, so carrying any of it forward would leave a service that
      // provisions nothing still holding another engine's images and Secret injections, ready to
      // come back the next time someone pins it.
      return { type: 'infraless' }
    case 'kubernetes':
      return {
        ...base,
        type: 'kubernetes',
        manifestSource: toKubernetesManifestSource(patch.manifestSource),
      }
    case 'custom': {
      // `manifestPath` is the one stored field this surface PUBLISHES, so it is also the only one a
      // patch can be said to have left out on purpose: omitted, it is CLEARED, and the manifest
      // type's own default applies again. Carried over from the stored row (which is what a plain
      // `...base` does), a caller correcting a path back to the default would keep deploying the old
      // one and have no way to say so, since the public shape has no other way to express "none".
      // Every field the public shape cannot express still rides `...rest`, for the reason the
      // function's own doc gives.
      const { manifestPath: _cleared, ...rest } = base ?? {}
      return {
        ...rest,
        type: 'custom',
        manifestId: patch.manifestId,
        ...(patch.manifestPath === undefined ? {} : { manifestPath: patch.manifestPath }),
      }
    }
    default:
      return unreachableProvisioning(patch)
  }
}

/** The compile-time half of the lowering above: a new public member has to be lowered explicitly. */
function unreachableProvisioning(value: never): never {
  throw new Error(`unmapped public service provisioning: ${JSON.stringify(value)}`)
}

// ---- what this deployment has WIRED -----------------------------------------

/**
 * Project one catalog model onto the flags that decide whether a run can dispatch, and, for one it
 * cannot, which of the four unrelated fixes applies.
 *
 * `available` / `policyBlocked` are optional internally (an older catalog omitted them) and REQUIRED
 * here, defaulted at this one seam. That is the honest direction: a caller cannot branch on a field
 * it may not receive, and "absent" for either of these means the same thing as false (not
 * selectable; not policy-blocked).
 *
 * `userScoped` answers off the flavour IN FORCE, which is what it has always answered and what a
 * caller on the published surface is already branching on. It is superseded rather than corrected,
 * because correcting it would move a stable field's meaning under those callers in both directions
 * at once: it is true today for a poolable vendor and false today for `claude-opus` with nothing
 * wired. `personalSubscription` is the answer both of those want, served beside it.
 *
 * `personalSubscription` is the kernel's own individual-usage predicate, read off the model
 * DECLARATION (so a subscription attached beside a metered gateway still counts) and gated on the
 * vendor being individual-only (so a workspace-pooled vendor does not). Same helper the run path
 * gates a personal credential on, so what this reports and what a dispatch actually needs cannot
 * drift.
 *
 * `personalVendors` is the set of vendors the person this key belongs to holds a live subscription
 * for, or `undefined` when there is no such person to have asked about. That distinction survives
 * onto the wire as `null` vs `false`, because "we looked and there is none" and "there was nobody to
 * look for" send an operator to two different screens.
 */
function toPublicWiredModel(
  model: ModelCatalog[number],
  personalVendors: ReadonlySet<string> | undefined,
): PublicWiredModel {
  const personalVendor = individualVendorForModelId(model.id)
  return {
    modelId: model.id,
    label: model.label,
    provider: model.providerLabel,
    available: model.available === true,
    policyBlocked: model.policyBlocked === true,
    userScoped: model.flavor === 'subscription',
    personalSubscription: personalVendor !== null,
    subscriptionConfigured:
      personalVendor === null || personalVendors === undefined
        ? null
        : personalVendors.has(personalVendor),
  }
}

/**
 * Project the workspace's VCS connection onto what it may DO.
 *
 * `provider` defaults to `github` for a row written before the column existed, which is how the
 * platform reads it everywhere else; stating it here keeps the public field non-null so a caller
 * never has to encode that fallback itself.
 */
function toPublicVcsConnection(connection: GitHubConnection): PublicVcsConnection {
  return {
    provider: connection.provider ?? 'github',
    accountLogin: connection.accountLogin,
    method: connection.method,
    canCreateRepos: connection.canCreateRepos === true,
    canManageWorkflows: connection.canManageWorkflows === true,
  }
}

/**
 * A model preset as this surface serves it.
 *
 * `version` and `providerPreference` stay off. The first is the SPA's reseed prompt, which is a
 * question about a library the operator maintains rather than about a run. The second names the
 * ROUTE order a resolution walks (direct, Bedrock, OpenRouter, …), and publishing it would put a
 * caller in the position of reading a preference whose members it cannot act on: nothing on this
 * surface picks a route, and the vocabulary is closed-but-persisted, so a retired member reaching a
 * public response is a shape this projection would then owe an answer for.
 */
function toPublicModelPreset(preset: ModelPreset): PublicModelPreset {
  return {
    presetId: preset.id,
    name: preset.name,
    isDefault: preset.isDefault,
    baseModelId: preset.baseModelId,
    overrides: { ...preset.overrides },
  }
}

function toPublicRiskPolicy(policy: RiskPolicy): PublicRiskPolicy {
  return {
    policyId: policy.id,
    name: policy.name,
    isDefault: policy.isDefault,
    isUnattendedDefault: policy.isUnattendedDefault,
    autonomy: policy.autonomy,
    autoMergeEnabled: policy.autoMergeEnabled,
    ciMaxAttempts: policy.ciMaxAttempts,
    dryRunRoles: [...policy.dryRunRoles],
    // The roles the allowlist SCOPES, not the classes it allows: a role with an entry may land only
    // what that entry names (an EMPTY entry lands nothing, which is a restriction and not an
    // absence), and the class vocabulary itself stays internal.
    submissionRestrictedRoles: Object.entries(policy.submissionClassesByRole)
      .filter(([, classes]) => classes !== undefined)
      .map(([role]) => role as PublicRiskPolicy['submissionRestrictedRoles'][number]),
  }
}

function registerWiringRoutes(app: Hono<AppEnv>): void {
  // Resolved for the user the key is BOUND to, and for nobody when it is not, which is most keys.
  // A model that belongs to a person (a locally-run endpoint, a personal subscription) must not be
  // inherited by an unbound key: it has no developer, and attributing someone else's endpoints to
  // it would report a catalog its runs cannot dispatch to. A bound key does name a person, and it
  // is the SAME person whose credential its runs unlock, so resolving under them is not a widening:
  // it is the only answer that matches what those runs will actually be able to do. See
  // `resolveWorkspaceModelCatalog`.
  //
  // Which is exactly why the omission is REPORTED, and reported at the level it happens at. A
  // locally-run endpoint is ABSENT from an unbound key's catalog entirely, so the answer is a list
  // where nothing is available, which reads as "add a provider key" and would send an operator to
  // change a setting that is already correct: that is a fact about the whole answer, and
  // `excludesUserScopedModels` states it (false for a bound key, whose endpoints did resolve). A
  // personal subscription's model is PRESENT but unjudged, which is a fact about that row, and
  // `personalSubscription` states it there. Reporting the second as the first would claim something
  // is missing while naming nothing, on a deployment where nothing is.
  //
  // "Unjudged" was as far as this got, and it was one step short of useful: an operator told a model
  // could not be judged still has to find out whether their subscription is the thing that would
  // have judged it, and the only route to that answer was re-minting the token to see. So the row
  // also carries whether the credential EXISTS for the person this key belongs to
  // (`subscriptionConfigured`), which is a lookup rather than an unlock and therefore costs no
  // password. Existence and admission stay separate: the catalog is still resolved under
  // `actsAsUserId` alone, so an unbound key reads `available: false` beside
  // `subscriptionConfigured: true`, meaning the model is wired, this credential may not spend it,
  // and the fix is a personal token rather than a provider key.
  buildHonoRoute(app, listPublicWiredModelsContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicWiredModelsContract.minScope)
    const container = c.get('container')
    const [catalog, personalVendors] = await Promise.all([
      resolveWorkspaceModelCatalog(container, auth.workspaceId, auth.actsAsUserId ?? undefined),
      personalSubscriptionVendors(container, auth),
    ])
    return c.json(
      {
        models: catalog.map((model) => toPublicWiredModel(model, personalVendors)),
        excludesUserScopedModels: auth.actsAsUserId === null && servesUserScopedModels(container),
      },
      200,
    )
  })

  buildHonoRoute(app, getPublicVcsConnectionContract, async (c) => {
    const auth = await authorizeOrThrow(c, getPublicVcsConnectionContract.minScope)
    const connection = await readVcsConnection(c.get('container'), auth.workspaceId)
    // Null is an ANSWER ("nothing connected"), which is the state a caller setting a workspace up
    // is most likely to be in, so it is a 200 carrying null rather than a 404.
    return c.json({ connection: connection ? toPublicVcsConnection(connection) : null }, 200)
  })

  buildHonoRoute(app, listPublicRiskPoliciesContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicRiskPoliciesContract.minScope)
    const policies = requireRiskPolicies(c)
    const rows = await policies.service.list(auth.workspaceId)
    return c.json({ policies: rows.map(toPublicRiskPolicy) }, 200)
  })

  buildHonoRoute(app, listPublicModelPresetsContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicModelPresetsContract.minScope)
    const presets = requireModelPresets(c)
    const rows = await presets.service.list(auth.workspaceId)
    return c.json({ presets: rows.map(toPublicModelPreset) }, 200)
  })
}
