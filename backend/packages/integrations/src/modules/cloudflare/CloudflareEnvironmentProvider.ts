import { CLOUDFLARE_ENV_TOKEN_SECRET_KEY } from '@cat-factory/contracts'
import {
  type CloudflareEnvironmentConfig,
  type ConnectionTestResult,
  type EnvironmentConnectionTestRequest,
  type EnvironmentManifest,
  type EnvironmentProvider,
  type EnvironmentStatusRequest,
  type EnvironmentTeardownRequest,
  type ProviderConfigField,
  type ProvisionEnvironmentRequest,
  type ProvisionedEnvironment,
  type RepoValidationRequest,
  type RepoValidationResult,
  type SecretResolver,
  type TeardownProbe,
  type UrlSafetyPolicy,
  STRICT_URL_SAFETY_POLICY,
} from '@cat-factory/kernel'
import { type MakeHttpError, readCappedText, safeFetch } from '../shared/safe-fetch.js'
import { assertSafeEnvironmentUrl } from '../environments/environments.logic.js'
import {
  type CloudflareTarget,
  cloudflareConfigToManifest,
  mapDeploymentState,
  parseCloudflareEnvConfig,
  provisionFieldsFor,
  resolveCloudflareTarget,
  vcsApiBase,
} from './cloudflare-environment.logic.js'

// The built-in Cloudflare Workers preview provider.
//
// It stands up a per-PR Cloudflare Worker WITHOUT ever talking to Cloudflare: standing one up
// means building it (installing a pnpm workspace, applying migrations, uploading a bundle),
// which needs a CI runner no facade has. The repository already has one, so the control plane
// is the VCS Deployments API — three plain HTTPS calls, identical on every facade:
//
//   provision -> POST a deployment for the PR head. The repo's preview workflow builds it.
//   status    -> read that deployment's latest status. `success` means live.
//   teardown  -> POST an `inactive` status. The workflow deletes the real resources.
//
// This replaces a hand-pasted `remote-custom` manifest that could only do the first call, and
// had to assert `ready` the moment the deployment record existed because the generic HTTP
// backend settles synchronously and the statuses endpoint returns an array the response
// mapping cannot read a URL out of. A native adapter has neither constraint: `status()` is
// real, so an environment is `provisioning` until the build actually finishes.

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 200_000
const USER_AGENT = 'cat-factory'
/** The reference preview workflow, checked by `validateRepo`. */
export const PREVIEW_WORKFLOW_PATH = '.github/workflows/preview-env.yml'

/** Carries the HTTP status so the API can surface a meaningful (redacted) error. */
export class CloudflareEnvironmentApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'CloudflareEnvironmentApiError'
  }
}

const makeError: MakeHttpError = (status, message) =>
  new CloudflareEnvironmentApiError(status, `Cloudflare preview provider ${message.toLowerCase()}`)

export interface CloudflareEnvironmentProviderOptions {
  defaultTimeoutMs?: number
  urlPolicy?: UrlSafetyPolicy
}

export class CloudflareEnvironmentProvider implements EnvironmentProvider {
  private readonly defaultTimeoutMs: number
  private readonly urlPolicy: UrlSafetyPolicy

  constructor(options: CloudflareEnvironmentProviderOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.urlPolicy = options.urlPolicy ?? STRICT_URL_SAFETY_POLICY
  }

  async provision(req: ProvisionEnvironmentRequest): Promise<ProvisionedEnvironment> {
    const config = parseCloudflareEnvConfig(req.manifest)
    const resolved = resolveCloudflareTarget(config, req.provisionContext)
    // A deterministic refusal, NOT a throw: the deployer renders a `failed` handle's
    // `lastError` verbatim on the board, so an operator sees the actual reason instead of a
    // stack trace. (The manifest this replaces would have provisioned a `pr-` environment
    // pointing at a host that never existed.)
    if (!resolved.ok) {
      return failed(resolved.error)
    }
    const { target } = resolved
    const fields = provisionFieldsFor(target)

    // Re-provisioning the SAME branch is the common case, not the exception: the deployer runs
    // on every attempt of a run, and the repository's own setup-change path may already have
    // built this head. Reuse that deployment instead of stacking another one — it makes
    // provisioning idempotent per (environment, ref), which is what the durable driver's replay
    // needs, and it lets an already-built environment settle `ready` immediately.
    const existing = await this.findLiveDeployment(
      config,
      target,
      resolved.target.ref,
      req.resolveSecret,
    )
    if (existing) {
      return {
        externalId: String(existing.id),
        url: target.url,
        status: existing.status,
        expiresAt: null,
        access: null,
        fields,
      }
    }

    const created = await this.request<{ id?: number | string }>(
      config,
      'POST',
      `/repos/${target.owner}/${target.repo}/deployments`,
      req.resolveSecret,
      {
        // The BRANCH, never a raw sha: the host resolves a branch against its OWN refs, so a
        // branch that does not exist here is refused there. A sha would happily name a fork PR
        // head (those live in the base repo as `refs/pull/<n>/head`) and get it built with the
        // preview credentials — the same boundary the workflow re-checks on its side.
        ref: target.ref,
        environment: target.environmentName,
        auto_merge: false,
        required_contexts: [],
        transient_environment: true,
        description: 'cat-factory preview',
        payload: {
          pullNumber: String(req.provisionContext?.pullNumber ?? ''),
          ...(req.provisionContext?.blockId ? { blockId: req.provisionContext.blockId } : {}),
          url: target.url,
          worker: target.workerName,
        },
      },
    )
    if (created?.id === undefined || created.id === null) {
      return failed('The deployments API accepted the request but returned no deployment id.')
    }

    return {
      externalId: String(created.id),
      // The URL is DERIVED, never read back: the Worker name is ours to choose, so its
      // workers.dev origin is knowable before anything is built. Reading it back would mean
      // waiting out a multi-minute deploy to learn a string we already know.
      url: target.url,
      // Honest, and the whole reason this is a native backend: the build has not run yet.
      status: 'provisioning',
      // Left to the provisioning service, which applies the manifest's `defaultTtlMs` against
      // the record's own `createdAt`. Computing a deadline here too would be a second source of
      // truth for the same number, and the two would drift the first time one of them changed.
      expiresAt: null,
      access: null,
      fields,
    }
  }

  async status(req: EnvironmentStatusRequest): Promise<ProvisionedEnvironment> {
    const config = parseCloudflareEnvConfig(req.manifest)
    const fields = req.provisionFields
    const url = fields.url ?? null
    // Target the repository recorded AT PROVISION TIME, never a freshly resolved one: the
    // handler's `repo` may have been re-pointed, or the block's repo linkage changed, while
    // this environment is live. A record we cannot address is `failed`, not silently ready.
    const owner = fields.owner
    const repo = fields.repo
    if (!owner || !repo || !req.externalId) {
      return {
        externalId: req.externalId,
        url,
        status: 'failed',
        expiresAt: null,
        access: null,
        fields,
        error: 'This environment record is missing the deployment it was provisioned as.',
      }
    }

    const statuses = await this.request<{ state?: string }[]>(
      config,
      'GET',
      `/repos/${owner}/${repo}/deployments/${encodeURIComponent(req.externalId)}/statuses?per_page=1`,
      req.resolveSecret,
    )
    const latest = Array.isArray(statuses) ? statuses[0] : undefined
    const status = mapDeploymentState(latest?.state)
    return {
      externalId: req.externalId,
      url,
      status,
      expiresAt: null,
      access: null,
      fields,
      ...(status === 'failed'
        ? {
            error:
              'The preview workflow reported a failed deployment. See the pull request checks.',
          }
        : {}),
    }
  }

  async teardown(req: EnvironmentTeardownRequest): Promise<{ status: 'torn_down' }> {
    const config = parseCloudflareEnvConfig(req.manifest)
    const { owner, repo } = req.provisionFields
    // Nothing addressable to tear down is SUCCESS, not an error: a provision that never got
    // a deployment id created no cloud resources, and reporting failure here would leave the
    // record stuck `tearing_down` forever.
    if (owner && repo && req.externalId) {
      await this.request(
        config,
        'POST',
        `/repos/${owner}/${repo}/deployments/${encodeURIComponent(req.externalId)}/statuses`,
        req.resolveSecret,
        { state: 'inactive', description: 'cat-factory teardown', auto_inactive: false },
      )
    }
    return { status: 'torn_down' }
  }

  /**
   * This provider has nothing to confirm the absence of.
   *
   * Its teardown marks a GitHub deployment `inactive`; it does not destroy a Cloudflare preview,
   * which Cloudflare itself retains and reclaims on its own schedule. So there is no resource
   * whose disappearance could be observed, and reporting `gone` would be claiming a reclaim that
   * this provider never performs. Stated here rather than left unimplemented so the reason
   * travels with the answer: an absent `confirmTeardown` means "this provider never said", where
   * this means "there is nothing to say, by design".
   */
  async confirmTeardown(): Promise<TeardownProbe> {
    return {
      state: 'unknown',
      retryable: false,
      reason:
        'Cloudflare preview deployments are reclaimed by Cloudflare, not by this teardown, which only marks the GitHub deployment inactive. There is no resource whose removal can be confirmed.',
    }
  }

  async testConnection(req: EnvironmentConnectionTestRequest): Promise<ConnectionTestResult> {
    if (!req.manifest) return { ok: false, message: 'Expected a Cloudflare environment manifest.' }
    let config: CloudflareEnvironmentConfig
    try {
      config = parseCloudflareEnvConfig(req.manifest)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    const pinned = config.repo?.trim()
    try {
      if (pinned) {
        // A pinned repo is testable end to end: the token must be able to READ it, which is
        // the same permission surface the deployment calls need.
        await this.request(config, 'GET', `/repos/${pinned}`, req.resolveSecret)
        return { ok: true, message: `Reached ${pinned} on ${vcsApiBase(config)}.` }
      }
      // Un-pinned, the repository is only known per provision, so the strongest thing that
      // can be checked now is that the token itself authenticates.
      await this.request(config, 'GET', '/rate_limit', req.resolveSecret)
      return {
        ok: true,
        message: `Token authenticated against ${vcsApiBase(config)}. The repository is resolved per run from the service frame.`,
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Pre-flight the DEPLOYED repository, before a run gets far enough to wait ten minutes for a
   * build that was never going to happen. Creating a deployment succeeds whether or not any
   * workflow listens for it, so "the deployment was accepted" proves nothing — the missing
   * workflow would surface as an environment stuck `provisioning` until its TTL. Checking that
   * the file exists turns that into a legible message at the start.
   */
  async validateRepo(req: RepoValidationRequest): Promise<RepoValidationResult> {
    const file = await req.readRepoFile(PREVIEW_WORKFLOW_PATH)
    if (file) return { ok: true, issues: [] }
    return {
      ok: false,
      issues: [
        {
          severity: 'error',
          path: PREVIEW_WORKFLOW_PATH,
          message:
            'This repository has no preview-environment workflow, so a deployment would be ' +
            'created and never built. Copy deploy/preview from cat-factory (or point the ' +
            'handler at the repository that holds the workflow).',
        },
      ],
    }
  }

  describeConfig(): ProviderConfigField[] {
    // The structured fields (subdomain, repo, name templates) are collected by the shared
    // native-adapter form off `describeManifestTemplate`; the only secret is the API token.
    return [
      {
        key: CLOUDFLARE_ENV_TOKEN_SECRET_KEY,
        label: 'VCS API token',
        help: 'A fine-grained token on the repository with Deployments: read & write, and nothing else.',
        secret: true,
        required: true,
      },
    ]
  }

  describeManifestTemplate(): EnvironmentManifest {
    return cloudflareConfigToManifest({
      label: 'Cloudflare Workers preview',
      workersSubdomain: '',
    })
  }

  // --- internals ----------------------------------------------------------

  /**
   * The newest deployment for this (environment, ref) whose latest status is not terminal, so
   * a re-provision re-attaches instead of stacking a duplicate. Best effort: a lookup failure
   * means we cannot PROVE one exists, and creating a fresh deployment is always the safe
   * answer — so it swallows and returns null rather than failing the provision.
   */
  private async findLiveDeployment(
    config: CloudflareEnvironmentConfig,
    target: CloudflareTarget,
    ref: string | undefined,
    resolveSecret: SecretResolver,
  ): Promise<{ id: string | number; status: 'ready' | 'provisioning' } | null> {
    if (!ref) return null
    try {
      const query = `environment=${encodeURIComponent(target.environmentName)}&ref=${encodeURIComponent(ref)}&per_page=10`
      const deployments = await this.request<{ id?: number | string }[]>(
        config,
        'GET',
        `/repos/${target.owner}/${target.repo}/deployments?${query}`,
        resolveSecret,
      )
      if (!Array.isArray(deployments)) return null
      for (const deployment of deployments) {
        if (deployment?.id === undefined || deployment.id === null) continue
        const statuses = await this.request<{ state?: string }[]>(
          config,
          'GET',
          `/repos/${target.owner}/${target.repo}/deployments/${encodeURIComponent(String(deployment.id))}/statuses?per_page=1`,
          resolveSecret,
        )
        const state = mapDeploymentState(Array.isArray(statuses) ? statuses[0]?.state : undefined)
        // `failed`/`torn_down` are spent — a fresh deployment is what re-drives the workflow.
        if (state === 'ready' || state === 'provisioning') {
          return { id: deployment.id, status: state }
        }
      }
      return null
    } catch {
      return null
    }
  }

  /** One SSRF-guarded, authenticated JSON call against the VCS API. */
  private async request<T>(
    config: CloudflareEnvironmentConfig,
    method: 'GET' | 'POST',
    path: string,
    resolveSecret: SecretResolver,
    body?: unknown,
  ): Promise<T> {
    const token = resolveSecret(CLOUDFLARE_ENV_TOKEN_SECRET_KEY)
    if (!token) {
      throw new CloudflareEnvironmentApiError(
        401,
        `The Cloudflare preview connection has no '${CLOUDFLARE_ENV_TOKEN_SECRET_KEY}' secret configured.`,
      )
    }
    const url = `${vcsApiBase(config)}${path}`
    const assertSafe = (candidate: string) =>
      assertSafeEnvironmentUrl(candidate, 'VCS API URL', this.urlPolicy)
    assertSafe(url)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.defaultTimeoutMs)
    let res: Response
    try {
      res = await safeFetch(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'user-agent': USER_AGENT,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        },
        assertSafe,
        makeError,
      )
    } finally {
      clearTimeout(timer)
    }

    const text = await readCappedText(res, MAX_RESPONSE_BYTES, makeError)
    if (!res.ok) {
      // The body is length-capped and carries no request headers, so the token cannot leak
      // through this message.
      throw new CloudflareEnvironmentApiError(
        res.status,
        `Cloudflare preview provider call failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
      )
    }
    if (!text.trim()) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new CloudflareEnvironmentApiError(
        res.status,
        'The VCS API returned a response that was not JSON.',
      )
    }
  }
}

/** A deterministic, non-throwing provision refusal carrying its reason for the board. */
function failed(error: string): ProvisionedEnvironment {
  return {
    externalId: null,
    url: null,
    status: 'failed',
    expiresAt: null,
    access: null,
    fields: {},
    error,
  }
}
