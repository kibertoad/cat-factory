import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Container COMPUTE vocabulary — where a service's container jobs run and at what
// size. Distinct from ENVIRONMENT provisioning (the ephemeral-env provider config in
// `environments.ts` / the event log in `provisioning-logs.ts`): this file is purely
// the compute-target + sizing vocabulary a dispatch resolves against.
//
// We do NOT provision compute on AWS/GCP/Azure ourselves — an org's self-hosted
// runner pool does that. What we own is a small, cloud-neutral vocabulary:
//   - a `CloudProvider` selecting which target a service's jobs run on, and
//   - an abstract t-shirt `InstanceSize` per service.
// At dispatch we resolve `(provider, size)` to the concrete instance-type id the
// target understands (the id string a custom pool expects) and hand it to the
// transport: a custom pool provisions itself from the id, and the local Docker
// backend maps the abstract size to `--memory`/`--cpus` limits. The provider is
// chosen per service and, when unset, falls back to the owning account's
// `defaultCloudProvider` (the engine resolves this at dispatch).
//
// Per-service sizing applies only to the backends that can honour it (the
// self-hosted pool and local Docker). The Cloudflare Container backend has a FIXED
// instance type per container class — set by `[[containers]] instance_type` in
// `wrangler.toml`, applying to every run — with no per-dispatch override, so it
// ignores these hints. Pick `cloudflare` when you don't need per-service sizing.
// ---------------------------------------------------------------------------

/**
 * Where a service's container jobs run. `cloudflare` is the built-in per-run
 * Container backend; `docker` is the local Docker/Podman daemon the local-mode
 * facade drives directly (no cloud at all — the abstract size maps to container
 * resource limits, and the Tester stands its infra up with Docker-in-Docker);
 * `aws`/`gcp`/`azure`/`custom` all route to a self-hosted runner pool that
 * provisions on that cloud — we only forward the resolved instance-type id, we
 * never call those clouds' APIs directly.
 */
export const cloudProviderSchema = v.picklist([
  'cloudflare',
  'docker',
  'aws',
  'gcp',
  'azure',
  'custom',
])
export type CloudProvider = v.InferOutput<typeof cloudProviderSchema>

/** Abstract, cloud-neutral instance size selectable per service. */
export const instanceSizeSchema = v.picklist(['small', 'medium', 'large', 'xlarge'])
export type InstanceSize = v.InferOutput<typeof instanceSizeSchema>

/** The default size used when a service has not picked one. */
export const DEFAULT_INSTANCE_SIZE: InstanceSize = 'medium'

/** The default provider used when neither the service nor its account has picked one. */
export const DEFAULT_CLOUD_PROVIDER: CloudProvider = 'cloudflare'

/**
 * Map each `(provider, size)` to the concrete instance-type id the target expects.
 * Cloudflare ids are real Container instance types (see `wrangler.toml`); the other
 * clouds carry conventional defaults a self-hosted pool can honour or override. For
 * `custom` the abstract size IS the id — a custom pool's manifest maps it to its own
 * sizing (so an org with bespoke orchestration plugs its definitions in there).
 */
export const INSTANCE_TYPE_IDS: Record<CloudProvider, Record<InstanceSize, string>> = {
  cloudflare: {
    small: 'standard-1',
    medium: 'standard-2',
    large: 'standard-3',
    xlarge: 'standard-4',
  },
  aws: {
    small: 't3.small',
    medium: 't3.large',
    large: 'm5.xlarge',
    xlarge: 'm5.2xlarge',
  },
  gcp: {
    small: 'e2-small',
    medium: 'e2-standard-2',
    large: 'e2-standard-4',
    xlarge: 'e2-standard-8',
  },
  azure: {
    small: 'Standard_B2s',
    medium: 'Standard_D2s_v5',
    large: 'Standard_D4s_v5',
    xlarge: 'Standard_D8s_v5',
  },
  // Pass-through: the abstract size id is forwarded verbatim (to the custom pool's
  // manifest, or — for `docker` — to the local transport, which maps it to concrete
  // container resource limits via `DOCKER_RESOURCE_LIMITS`).
  custom: {
    small: 'small',
    medium: 'medium',
    large: 'large',
    xlarge: 'xlarge',
  },
  docker: {
    small: 'small',
    medium: 'medium',
    large: 'large',
    xlarge: 'xlarge',
  },
}

/** Resolve the concrete instance-type id to send to the transport for a service. */
export function resolveInstanceTypeId(
  provider: CloudProvider = DEFAULT_CLOUD_PROVIDER,
  size: InstanceSize = DEFAULT_INSTANCE_SIZE,
): string {
  return INSTANCE_TYPE_IDS[provider][size]
}

/**
 * Concrete container resource limits per abstract size, used by the local
 * Docker/Podman runner backend (`--memory` / `--cpus` on `docker run`). The
 * local facade never provisions cloud instances — it sizes the per-job container
 * on the host daemon — so the abstract `InstanceSize` maps straight to limits here
 * rather than to a cloud instance-type id.
 */
export interface DockerResourceLimits {
  /** `--memory` value (e.g. `2g`). */
  memory: string
  /** `--cpus` value (e.g. `2`). */
  cpus: string
}

export const DOCKER_RESOURCE_LIMITS: Record<InstanceSize, DockerResourceLimits> = {
  small: { memory: '1g', cpus: '1' },
  medium: { memory: '2g', cpus: '2' },
  large: { memory: '4g', cpus: '4' },
  xlarge: { memory: '8g', cpus: '8' },
}

/** Resolve the local container resource limits for a service's abstract size. */
export function resolveDockerResources(
  size: InstanceSize = DEFAULT_INSTANCE_SIZE,
): DockerResourceLimits {
  return DOCKER_RESOURCE_LIMITS[size]
}
