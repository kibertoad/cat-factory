// Frontend mirrors of the per-user secret + provider-config wire contracts
// (`@cat-factory/contracts` user-secret.ts + provider-config.ts).
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  UserSecretKind,
  ProviderConfigField,
  UserSecretStatus,
  UserSecretDescriptor,
  StoreUserSecretInput,
  TestUserSecretInput,
  ConnectionTestResult,
} from '@cat-factory/contracts'
