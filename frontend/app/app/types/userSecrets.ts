// Frontend mirrors of the per-user secret + provider-config wire contracts
// (`@cat-factory/contracts` user-secret.ts + provider-config.ts).

export type UserSecretKind = 'github_pat'

/** One config value a kind needs, rendered as a single form field. */
export interface ProviderConfigField {
  key: string
  label: string
  help?: string
  placeholder?: string
  secret?: boolean
  required?: boolean
  type?: 'text' | 'password' | 'select'
  options?: { value: string; label: string }[]
}

/** Read-only status of one stored per-user secret — never the secret value. */
export interface UserSecretStatus {
  kind: UserSecretKind
  label: string
  hasSecret: boolean
  metadata?: Record<string, string>
  connectedAt: number
}

/** A kind's self-description for the generic connect form. */
export interface UserSecretDescriptor {
  kind: UserSecretKind
  label: string
  configFields: ProviderConfigField[]
  supportsTest: boolean
}

export interface StoreUserSecretInput {
  label?: string
  secret: string
  metadata?: Record<string, string>
}

export interface TestUserSecretInput {
  secret: string
  metadata?: Record<string, string>
}

export interface ConnectionTestResult {
  ok: boolean
  message?: string
}
