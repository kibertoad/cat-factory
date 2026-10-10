// Provider self-description + connection wire contracts for the generic connect form
// used by the two infrastructure providers: the ephemeral-environment provider and the
// self-hosted runner pool. Both speak the same ProviderDescriptor.
//
// The shared shapes are sourced from @cat-factory/contracts (single source of truth).
// The register/test request bodies are the union of the two per-kind contract inputs
// (the composable picks the right contract per kind). `ProviderConnectionKind` and the
// generic `ProviderConnection` view have no exported contract type, so they stay
// frontend-only below.

export type {
  ProviderConfigField,
  ProviderDescriptor,
  ConnectionTestResult,
} from '@cat-factory/contracts'

/** The two infrastructure providers configured through the generic connect form. */
export type ProviderConnectionKind = 'environment' | 'runner-pool'

/**
 * A tab of the Infrastructure window, and the vocabulary `ui.infrastructureTab` selects from.
 *
 * Deliberately WIDER than {@link ProviderConnectionKind}: the window also hosts tabs that are
 * not a provider connection at all (long-lived shared Compose stacks, the workspace's private
 * package registries). Typing the store's tab ref as the connection kinds alone is what made
 * those tabs unreachable by deep link — a banner, a command-palette entry or an Integrations-hub
 * pointer could open the window but never land the user on the tab it meant. Every tab
 * `InfrastructureWindow.vue` can render must have a name here.
 */
export type InfrastructureTab =
  | ProviderConnectionKind
  | 'shared-stacks'
  | 'package-registries'
  | 'capability-credentials'

/**
 * A SECTION within an Infrastructure tab that a deep link can land the user on, rather than at
 * the top of the tab with the section to hunt for. A closed union rather than a bare string, so
 * the store's setter and the panel that honours it cannot drift apart silently: today's only
 * member is the `kubernetes` provision-type section the `cat-factory k3s` hand-off targets, which
 * sits below the default-provision picker in a tab long enough to need scrolling.
 */
export type InfrastructureScrollTarget = 'kubernetes'

/** A workspace's provider binding, as exposed to clients (never secret values). */
export interface ProviderConnection {
  /** The runner-backend kind for a runner-pool connection (`manifest` | `kubernetes`). */
  kind?: string
  providerId: string
  label: string
  baseUrl: string
  connectedAt: number
  /** Which secret/config keys are stored (names only), so the UI shows completeness. */
  secretKeys: string[]
  /**
   * The stored discriminated runner-backend config, sans secrets, so the connect form
   * can prefill its non-secret fields on edit. Shape mirrors the backend
   * `RunnerBackendConfig` ({ kind: 'manifest' | 'kubernetes', … }); kept opaque here.
   */
  config?: Record<string, unknown>
}

// The connect form builds the manifest dynamically from a server-provided scaffold
// (`ProviderDescriptor.manifestTemplate`/`savedManifest`) overlaid with form values, so
// the FE treats it as an opaque JSON bag. The backend re-validates it against the precise
// per-provider manifest contract on receipt; the composable casts to the contract input
// type at the single `send` boundary.

/**
 * The assembled register payload. The environment provider sends a full `manifest`.
 * The runner-pool ("agent runner backend") provider sends a discriminated `config`
 * ({ kind: 'manifest' | 'kubernetes', … }); for back-compat of the manifest editor it
 * may instead send a bare `manifest`, which the composable wraps into the manifest
 * backend config. The write-only secret bundle rides alongside.
 */
export interface RegisterProviderInput {
  manifest?: Record<string, unknown>
  /** The discriminated runner-backend config (manifest pool, kubernetes, or a custom kind). */
  config?: Record<string, unknown>
  /**
   * The selected backend kind, used to wrap a bare `manifest` into the discriminated config
   * (`{ kind, manifest }`). Defaults to `manifest`. A CUSTOM registered kind passes its slug
   * here so the flat-form save isn't mis-tagged as the built-in manifest backend.
   */
  backendKind?: string
  secrets: Record<string, string>
}

/** The test/probe payload (manifest-driven, native, or a discriminated runner config). */
export interface TestProviderInput {
  manifest?: Record<string, unknown>
  config?: Record<string, unknown>
  backendKind?: string
  secrets?: Record<string, string>
}
