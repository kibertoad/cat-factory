import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Container provisioning vocabulary.
//
// We do NOT provision compute on AWS/GCP/Azure ourselves — an org's self-hosted
// runner pool does that. What we own is a small, cloud-neutral vocabulary:
//   - a `CloudProvider` selecting which target a service's jobs run on, and
//   - an abstract t-shirt `InstanceSize` per service.
// At dispatch we resolve `(provider, size)` to the concrete instance-type id the
// target understands (a Cloudflare instance type, or the id string a custom pool
// expects) and hand that id to the transport — Cloudflare maps it to a Container
// instance type; a custom pool provisions itself from the id. The provider is
// chosen per service and defaults to the owning account's `defaultCloudProvider`.
// ---------------------------------------------------------------------------

/**
 * Where a service's container jobs run. `cloudflare` is the built-in per-run
 * Container backend; `aws`/`gcp`/`azure`/`custom` all route to a self-hosted
 * runner pool that provisions on that cloud — we only forward the resolved
 * instance-type id, we never call those clouds' APIs directly.
 */
export const cloudProviderSchema = v.picklist(['cloudflare', 'aws', 'gcp', 'azure', 'custom'])
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
  // Pass-through: the abstract size id is forwarded verbatim to the custom pool,
  // which maps it via its own manifest.
  custom: {
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
