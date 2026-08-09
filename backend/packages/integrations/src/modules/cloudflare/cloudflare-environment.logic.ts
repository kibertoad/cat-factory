import {
  CLOUDFLARE_DEFAULT_ENVIRONMENT_NAME_TEMPLATE,
  CLOUDFLARE_DEFAULT_WORKER_NAME_TEMPLATE,
  CLOUDFLARE_ENV_TOKEN_SECRET_KEY,
  cloudflareConnectionConfigSchema,
  cloudflareEnvironmentConfigSchema,
  parseStoredProviderConfig,
} from '@cat-factory/contracts'
import type {
  CloudflareConnectionConfig,
  CloudflareEnvironmentConfig,
  EnvironmentManifest,
  EnvironmentStatus,
  ProvisionContext,
} from '@cat-factory/kernel'

// Pure helpers for the built-in Cloudflare Workers preview ENVIRONMENT backend: read the
// operator's config off the stored manifest, render the per-PR resource names and the
// environment URL, and map the VCS deployment's own status vocabulary onto ours. No I/O —
// the provider does the fetches.
//
// Everything here is deliberately total and side-effect free so the interesting decisions
// (what a missing pull number means, which deployment state counts as live) are unit-testable
// without a VCS.

/** The default VCS API root when the config names none. */
export const DEFAULT_VCS_API_BASE = 'https://api.github.com'

/** The `providerConfig` key the Cloudflare config is stored under on the manifest. */
const PROVIDER_CONFIG_KEY = 'cloudflare'

/** Stable provider id for the connection row (mirrors `kubernetes`'s). */
export const CLOUDFLARE_PROVIDER_ID = 'cloudflare'

/**
 * Read the per-workspace Cloudflare config off the stored manifest's `providerConfig`.
 *
 * Re-validated against the schema the connect controller admitted it through, for the reason
 * {@link parseStoredProviderConfig} states: the same treatment every native backend gives its
 * own stored config.
 */
export function parseCloudflareEnvConfig(
  manifest: EnvironmentManifest,
): CloudflareEnvironmentConfig {
  const raw = manifest.providerConfig?.[PROVIDER_CONFIG_KEY]
  if (!raw || typeof raw !== 'object') {
    throw new Error('Cloudflare environment manifest is missing its providerConfig.cloudflare')
  }
  return parseStoredProviderConfig(
    cloudflareEnvironmentConfigSchema,
    raw,
    'Cloudflare environment manifest',
  )
}

/**
 * Build the stored manifest that carries a Cloudflare env config in its `providerConfig`.
 *
 * The request templates are required by the manifest schema and are NEVER executed — this is
 * a native adapter, so it drives the deployments API in code. They are filled in with the
 * calls the adapter actually makes so an operator reading the stored row sees the truth
 * rather than empty scaffolding.
 */
export function cloudflareConfigToManifest(
  config: CloudflareEnvironmentConfig,
): EnvironmentManifest {
  const baseUrl = config.apiBaseUrl?.trim() || DEFAULT_VCS_API_BASE
  return {
    providerId: CLOUDFLARE_PROVIDER_ID,
    label: config.label,
    baseUrl,
    auth: { type: 'bearer', secretRef: { key: CLOUDFLARE_ENV_TOKEN_SECRET_KEY } },
    provision: { method: 'POST', pathTemplate: '/repos/{owner}/{repo}/deployments' },
    status: { method: 'GET', pathTemplate: '/repos/{owner}/{repo}/deployments/{id}/statuses' },
    teardown: { method: 'POST', pathTemplate: '/repos/{owner}/{repo}/deployments/{id}/statuses' },
    response: { urlPath: 'payload.url', externalIdPath: 'id' },
    ...(config.defaultTtlMs === undefined ? {} : { defaultTtlMs: config.defaultTtlMs }),
    providerConfig: { [PROVIDER_CONFIG_KEY]: config },
  }
}

/**
 * Read only what it takes to REACH the VCS API off the stored manifest, for the reclaim path.
 *
 * The counterpart of {@link parseKubernetesEnvConnection}, and the same reason: teardown posts
 * one `inactive` deployment status, so a `workersSubdomain` or name template that stopped
 * matching the contract must not be what leaves a preview nobody can mark inactive. An absent
 * `providerConfig.cloudflare` reads as an empty connection rather than a refusal, because every
 * field this shape carries has a documented default.
 */
export function parseCloudflareEnvConnection(
  manifest: EnvironmentManifest,
): CloudflareConnectionConfig {
  const raw = manifest.providerConfig?.[PROVIDER_CONFIG_KEY]
  if (!raw || typeof raw !== 'object') return {}
  return parseStoredProviderConfig(
    cloudflareConnectionConfigSchema,
    raw,
    'Cloudflare environment manifest',
  )
}

/** The VCS API root for a config, without a trailing slash. */
export function vcsApiBase(config: CloudflareConnectionConfig): string {
  return (config.apiBaseUrl?.trim() || DEFAULT_VCS_API_BASE).replace(/\/+$/, '')
}

/**
 * Render a `{{placeholder}}` name template. Only the three provision-context values are in
 * scope; an unknown placeholder renders EMPTY rather than being left literal, so a typo can
 * never produce a name containing braces (which no Worker name may hold).
 */
export function renderNameTemplate(
  template: string,
  vars: { pullNumber: number; branch?: string; blockId?: string },
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    if (key === 'pullNumber') return String(vars.pullNumber)
    if (key === 'branch') return sanitizeNameFragment(vars.branch ?? '')
    if (key === 'blockId') return sanitizeNameFragment(vars.blockId ?? '')
    return ''
  })
}

/**
 * Reduce a free-form value (a branch name, a block id) to the character set a Worker name and
 * a hostname label allow. A branch legitimately contains `/` and uppercase; leaving either in
 * would produce an unreachable URL, so it is folded rather than rejected.
 */
function sanitizeNameFragment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The per-PR identifiers a provision/status/teardown call operates on. */
export interface CloudflareTarget {
  owner: string
  repo: string
  /**
   * The git ref the deployment names — always the PR HEAD BRANCH, never a sha. The host
   * resolves a branch against its own refs, so a branch that does not exist there is refused;
   * a sha would happily name a fork PR head (which lives in the base repo as
   * `refs/pull/<n>/head`) and get it built with the preview credentials.
   */
  ref: string
  /** The deployment environment name — the contract with the repo's preview workflow. */
  environmentName: string
  /** The per-PR Worker name the URL is derived from. */
  workerName: string
  /** `https://<worker>.<subdomain>.workers.dev`. */
  url: string
}

export type CloudflareTargetResult =
  | { ok: true; target: CloudflareTarget }
  | { ok: false; error: string }

/**
 * Resolve everything a provision needs from the config + the block's provision context.
 *
 * This is where the backend earns its keep over the hand-pasted manifest it replaces. That
 * manifest interpolated `{{input.pullNumber}}` into a body, and a missing pull number renders
 * EMPTY there — producing environment `pr-`, a URL pointing at a host that will never exist,
 * and an environment recorded `ready`. A run with no open PR is a real case (a blueprint-only
 * pipeline, the environment self-test diagnostic), so the answer must be a deterministic,
 * legible refusal rather than a plausible-looking string.
 */
export function resolveCloudflareTarget(
  config: CloudflareEnvironmentConfig,
  ctx: ProvisionContext | undefined,
): CloudflareTargetResult {
  const pullNumber = ctx?.pullNumber
  if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber) || pullNumber <= 0) {
    return {
      ok: false,
      error:
        'A Cloudflare preview environment is per pull request, and this run has no open pull ' +
        'request yet. Run it on a pipeline whose coder step opens one before the deployer step.',
    }
  }

  // The deployment must name a ref, and only a branch is safe to name (see `CloudflareTarget`).
  // A PR always has a head branch, so an absent one means the provision context was not wired —
  // refuse rather than substitute something that would create a deployment of the wrong thing.
  const ref = ctx?.branch?.trim()
  if (!ref) {
    return {
      ok: false,
      error:
        'The run did not supply a head branch, so there is no ref to deploy. This is a wiring ' +
        'problem rather than a configuration one — the deployer resolves the branch from the ' +
        "coder step's pull request.",
    }
  }

  const configured = config.repo?.trim()
  const [owner, repo] = configured
    ? (configured.split('/') as [string, string])
    : [ctx?.repoOwner ?? '', ctx?.repoName ?? '']
  if (!owner || !repo) {
    return {
      ok: false,
      error:
        'Could not resolve the repository holding the preview workflow. Link the service frame ' +
        'to a repository, or pin `repo` ("owner/repo") on the Cloudflare handler.',
    }
  }

  const vars = {
    pullNumber,
    branch: ref,
    ...(ctx?.blockId === undefined ? {} : { blockId: ctx.blockId }),
  }
  const environmentName = renderNameTemplate(
    config.environmentNameTemplate ?? CLOUDFLARE_DEFAULT_ENVIRONMENT_NAME_TEMPLATE,
    vars,
  )
  const workerName = renderNameTemplate(
    config.workerNameTemplate ?? CLOUDFLARE_DEFAULT_WORKER_NAME_TEMPLATE,
    vars,
  )
  if (!environmentName || !workerName) {
    return {
      ok: false,
      error: 'The configured name templates rendered empty for this run.',
    }
  }

  return {
    ok: true,
    target: {
      owner,
      repo,
      ref,
      environmentName,
      workerName,
      url: `https://${workerName}.${config.workersSubdomain}.workers.dev`,
    },
  }
}

/**
 * Map a VCS deployment status state onto our lifecycle.
 *
 * `inactive` deliberately maps to `torn_down`, not `failed`: it is what a teardown POSTS, so
 * reading it back means the environment is gone, which is a normal end of life. An unknown
 * state maps to `provisioning` (keep polling) rather than `failed`, because a vendor adding a
 * state must not turn every live environment red.
 */
export function mapDeploymentState(state: string | null | undefined): EnvironmentStatus {
  switch ((state ?? '').trim().toLowerCase()) {
    case 'success':
      return 'ready'
    case 'failure':
    case 'error':
      return 'failed'
    case 'inactive':
      return 'torn_down'
    // `pending`, `queued`, `in_progress`, an absent status, anything new.
    default:
      return 'provisioning'
  }
}

/**
 * The provision fields persisted for later status/teardown calls. They pin the repository and
 * the resolved names AT PROVISION TIME so a later status read cannot drift onto a different
 * target — the handler's `repo` may be re-pointed, or the block's repo linkage changed, while
 * an environment is live.
 */
export function provisionFieldsFor(target: CloudflareTarget): Record<string, string> {
  return {
    owner: target.owner,
    repo: target.repo,
    environmentName: target.environmentName,
    workerName: target.workerName,
    url: target.url,
  }
}
