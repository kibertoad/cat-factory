import type {
  EnvironmentBackendConfig,
  InfraEngine,
  InfraHandlerConfig,
  KubernetesManifestSource,
  ProvisionType,
  ServiceProvisioning,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import type {
  EnvironmentBackendProvider,
  EnvironmentBackendRegistry,
} from './environment-backends.js'

// Shared lowering + validation for a per-type infra HANDLER row (the "how"), used by BOTH
// the per-workspace handler store (`EnvironmentConnectionService`) and the per-USER override
// store (`EnvironmentUserHandlerService`). Keeping the engine→backend lowering, the SSRF /
// secret-completeness checks, and the persisted-metadata derivation in one place stops the
// two stores from drifting on what a valid handler is. See
// docs/initiatives/per-service-provision-types.md.

/**
 * A placeholder manifest source for config validation / metadata extraction, where the
 * real (service-owned) source isn't available. The kube backend's `assertConfigSafe` /
 * `connectionMeta` only read the apiserver/sizing fields, never the source, so a stand-in
 * is safe — the REAL source is merged in at provision time (`resolveProviderForType`).
 */
const PLACEHOLDER_MANIFEST_SOURCE: KubernetesManifestSource = {
  type: 'colocated',
  path: '.',
}

/**
 * Overlay a supplied secret bundle onto the stored one so an EDIT preserves write-only secrets
 * the operator left blank. A non-empty supplied value replaces the stored one; a blank string
 * (the edit form's "leave to keep the saved token") or an omitted key keeps the stored value.
 * Shared by the workspace handler store and the per-user override store so they can't drift on
 * how a saved secret is preserved.
 */
export function overlaySecrets(
  stored: Record<string, string>,
  supplied: Record<string, string> | undefined,
): Record<string, string> {
  const out = { ...stored }
  for (const [key, value] of Object.entries(supplied ?? {})) {
    if (typeof value === 'string' && value.trim() === '') continue
    out[key] = value
  }
  return out
}

/**
 * Coerce an env-manifest `providerId` (regex `^[a-z0-9-]+$`, so a leading `-` is allowed) into a
 * valid `manifestId` (`^[a-z0-9][a-z0-9-]*$`) for the compat bridge's `acceptsManifestId`: strip
 * leading non-alphanumerics, cap to 64, and fall back to `custom` if nothing usable remains.
 */
export function toManifestId(providerId: string): string {
  const id = providerId.replace(/^[^a-z0-9]+/, '').slice(0, 64)
  return id.length > 0 ? id : 'custom'
}

/**
 * The service-owned provisioning inputs ("what + where" + render inputs) merged into the
 * workspace engine/handler config at provision time. For a KUBE engine: the manifest source plus
 * the container-deploy render fields (image overrides, per-environment helm releases, secret
 * injections). For the `local-docker` (compose) engine: the declarative STACK RECIPE — the
 * service owns the recipe (multi-`-f` layering, profiles, env-file materialization, setup steps,
 * health gate), the workspace handler owns only the daemon connection, so the recipe is folded
 * into the compose `providerConfig` here (the compose analogue of merging `manifestSource`).
 */
export type ServiceProvisioningInputs = Pick<
  ServiceProvisioning,
  'manifestSource' | 'images' | 'helmReleases' | 'secretInjections' | 'recipe'
>

type KubeHelmRelease = NonNullable<ServiceProvisioningInputs['helmReleases']>[number]

/**
 * Merge the workspace engine's (cluster-shared) helm releases with the service's
 * (per-environment) ones, keyed by release `name` so a service entry OVERRIDES a same-named
 * engine entry instead of installing the release twice. Engine order is preserved; service-only
 * releases are appended.
 */
function mergeHelmReleases(
  engine: KubeHelmRelease[] | undefined,
  service: KubeHelmRelease[] | undefined,
): KubeHelmRelease[] {
  const byName = new Map<string, KubeHelmRelease>()
  for (const rel of engine ?? []) byName.set(rel.name, rel)
  for (const rel of service ?? []) byName.set(rel.name, rel)
  return [...byName.values()]
}

/**
 * Lower a discriminated-by-`engine` {@link InfraHandlerConfig} into the discriminated-by-`kind`
 * {@link EnvironmentBackendConfig} the backend registry consumes. For a kube engine the source
 * is resolved by precedence: the service-owned `manifestSource` (the split the whole initiative
 * is about) > a legacy source the compat bridge stored inline (a kube handler config MAY carry
 * one) > a placeholder (validation/metadata paths, where the kube backend reads only the
 * apiserver/sizing fields, never the source). The service's render inputs (image overrides,
 * secret injections, per-env helm releases) are folded in too; the workspace's shared
 * (`scope: 'shared'`) helm releases on the engine config are merged with the service's by
 * release name (a same-named service release overrides the engine one — no double install).
 */
export function handlerConfigToBackendConfig(
  config: InfraHandlerConfig,
  backendKind: string,
  service?: ServiceProvisioningInputs,
): EnvironmentBackendConfig {
  switch (config.engine) {
    case 'local-docker': {
      // The workspace `local-docker` handler owns the daemon connection; the SERVICE owns the
      // declarative stack recipe (the "what/where"). Fold the service's recipe into the compose
      // `providerConfig` at resolve time — the compose analogue of merging a kube `manifestSource`
      // — so the provider keys purely on the persisted, merged config. Absent ⇒ the simple
      // single-file `composePath` path (the recipe is optional, so an undeclared service is
      // byte-for-byte unchanged).
      if (!service?.recipe) {
        return { kind: backendKind, manifest: config.manifest } as EnvironmentBackendConfig
      }
      const providerConfig = { ...config.manifest.providerConfig, recipe: service.recipe }
      return {
        kind: backendKind,
        manifest: { ...config.manifest, providerConfig },
      } as EnvironmentBackendConfig
    }
    case 'remote-custom':
      return { kind: backendKind, manifest: config.manifest } as EnvironmentBackendConfig
    case 'local-k3s':
    case 'remote-kubernetes': {
      const kube = config.kubernetes as typeof config.kubernetes & {
        manifestSource?: KubernetesManifestSource
      }
      const source = service?.manifestSource ?? kube.manifestSource ?? PLACEHOLDER_MANIFEST_SOURCE
      const helmReleases = mergeHelmReleases(kube.helmReleases, service?.helmReleases)
      return {
        kind: 'kubernetes',
        kubernetes: {
          ...kube,
          manifestSource: source,
          ...(helmReleases.length > 0 ? { helmReleases } : {}),
          ...(service?.images ? { images: service.images } : {}),
          ...(service?.secretInjections ? { secretInjections: service.secretInjections } : {}),
        },
      }
    }
  }
}

/** Resolve the backend that builds a handler's provider: the pinned kind, else by engine. */
export function resolveHandlerBackend(
  registry: EnvironmentBackendRegistry,
  engine: InfraEngine,
  backendKind: string | undefined,
): EnvironmentBackendProvider {
  if (backendKind) {
    const backend = registry.get(backendKind)
    if (!backend) throw new ValidationError(`Unknown environment backend kind '${backendKind}'`)
    return backend
  }
  const backend = registry.byEngine(engine)
  if (!backend)
    throw new ValidationError(`No environment backend is configured for engine '${engine}'`)
  return backend
}

/** The validated, persistence-ready non-secret fields of a per-type infra handler. */
export interface InfraHandlerPersistedFields {
  provisionType: ProvisionType
  manifestId: string | null
  engine: InfraEngine
  backendKind: string
  providerId: string
  label: string
  baseUrl: string
  /** The serialized {@link InfraHandlerConfig} (sans secrets). */
  handlerJson: string
  acceptsManifestId: string | null
}

/** Register/upsert input shared by both the workspace and per-user handler stores. */
export interface BuildInfraHandlerInput {
  provisionType: ProvisionType
  /** For a `custom` type keyed to a specific manifest id; absent ⇒ the bare (single) handler. */
  manifestId?: string | null
  config: InfraHandlerConfig
  /**
   * The env-backend registry kind that builds the provider. Absent ⇒ resolved from the
   * config's engine (the generic backend for that engine). Pin it to select a specific
   * custom backend that rides a shared engine (e.g. `remote-custom`).
   */
  backendKind?: string
  secrets: Record<string, string>
}

/**
 * Validate a handler config (lower it, SSRF/runtime-safety check it, verify every referenced
 * secret key is supplied) and derive its persisted non-secret fields. Throws a
 * {@link ValidationError} on an unsafe config or a missing secret value. The caller encrypts
 * the secret bundle and assembles the (store-specific) record around these fields.
 */
export function buildInfraHandlerFields(
  registry: EnvironmentBackendRegistry,
  input: BuildInfraHandlerInput,
  opts: { urlPolicy?: UrlSafetyPolicy; customTlsSupported?: boolean } = {},
): InfraHandlerPersistedFields {
  const engine = input.config.engine
  const backend = resolveHandlerBackend(registry, engine, input.backendKind)
  // Validation/metadata only read the apiserver/sizing fields, so the placeholder source is fine.
  const backendConfig = handlerConfigToBackendConfig(input.config, backend.kind)
  backend.assertConfigSafe(backendConfig, {
    ...(opts.urlPolicy ? { urlPolicy: opts.urlPolicy } : {}),
    ...(opts.customTlsSupported !== undefined
      ? { customTlsSupported: opts.customTlsSupported }
      : {}),
  })
  const missing = backend
    .referencedSecretKeys(backendConfig)
    .filter((key) => !(key in input.secrets))
  if (missing.length) {
    throw new ValidationError(`Missing secret values for: ${missing.join(', ')}`)
  }
  const meta = backend.connectionMeta(backendConfig)
  return {
    provisionType: input.provisionType,
    manifestId: input.manifestId ?? null,
    engine,
    backendKind: backend.kind,
    providerId: meta.providerId,
    label: meta.label,
    baseUrl: meta.baseUrl,
    handlerJson: JSON.stringify(input.config),
    acceptsManifestId:
      input.config.engine === 'remote-custom' ? input.config.acceptsManifestId : null,
  }
}
