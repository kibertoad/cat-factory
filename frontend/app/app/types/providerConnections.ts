// Frontend mirrors of the shared provider self-description + connection wire contracts
// (`@cat-factory/contracts` provider-config.ts + environments.ts + runners.ts), used by
// the generic connect form for the two infrastructure providers: the ephemeral-environment
// provider and the self-hosted runner pool. Both speak the same ProviderDescriptor.

/** The two infrastructure providers configured through the generic connect form. */
export type ProviderConnectionKind = 'environment' | 'runner-pool'

/** One config value a provider needs, rendered as a single form field. */
export interface ProviderConfigField {
  key: string
  label: string
  help?: string
  placeholder?: string
  secret?: boolean
  required?: boolean
  type?: 'text' | 'password' | 'select'
  options?: { value: string; label: string }[]
  /** The provider/manifest default; a field with one is optional (UI shows a hint). */
  default?: string
}

/** What the SPA needs to render a provider's connect form. */
export interface ProviderDescriptor {
  providerId: string
  label: string
  kind: 'native' | 'manifest'
  configFields: ProviderConfigField[]
  supportsTest: boolean
  /** Required-without-default keys not yet supplied (drives the banner). */
  missingRequired: string[]
  /** Base manifest a native provider's flat fields are overlaid onto before save. */
  manifestTemplate?: Record<string, unknown>
}

/** A workspace's provider binding, as exposed to clients (never secret values). */
export interface ProviderConnection {
  providerId: string
  label: string
  baseUrl: string
  connectedAt: number
  /** Which secret/config keys are stored (names only), so the UI shows completeness. */
  secretKeys: string[]
}

export interface ConnectionTestResult {
  ok: boolean
  message?: string
}

/** The assembled register payload (a full manifest + the write-only secret bundle). */
export interface RegisterProviderInput {
  manifest: Record<string, unknown>
  secrets: Record<string, string>
}

export interface TestProviderInput {
  manifest?: Record<string, unknown>
  config?: Record<string, string>
  secrets?: Record<string, string>
}
