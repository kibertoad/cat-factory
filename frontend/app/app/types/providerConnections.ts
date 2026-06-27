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

/** A workspace's provider binding, as exposed to clients (never secret values). */
export interface ProviderConnection {
  providerId: string
  label: string
  baseUrl: string
  connectedAt: number
  /** Which secret/config keys are stored (names only), so the UI shows completeness. */
  secretKeys: string[]
}

// The connect form builds the manifest dynamically from a server-provided scaffold
// (`ProviderDescriptor.manifestTemplate`/`savedManifest`) overlaid with form values, so
// the FE treats it as an opaque JSON bag. The backend re-validates it against the precise
// per-provider manifest contract on receipt; the composable casts to the contract input
// type at the single `send` boundary.

/** The assembled register payload (a full manifest + the write-only secret bundle). */
export interface RegisterProviderInput {
  manifest: Record<string, unknown>
  secrets: Record<string, string>
}

/** The test/probe payload (manifest-driven or native), shared by both providers. */
export interface TestProviderInput {
  manifest?: Record<string, unknown>
  config?: Record<string, string>
  secrets?: Record<string, string>
}
