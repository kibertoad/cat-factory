// ---------------------------------------------------------------------------
// Model selection & best-practice prompt fragments. Mirrors the
// `@cat-factory/contracts` schemas served read-only by the backend.
// ---------------------------------------------------------------------------
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  SubscriptionVendor,
  ModelCost,
  ModelOption,
  PersonalSubscriptionStatus,
  StorePersonalSubscriptionInput,
  ApiKeyScope,
  ApiKeyProvider,
  ApiKey,
  AddApiKeyInput,
  UpdateApiKeyInput,
  VendorCredential,
  UpdateVendorCredentialInput,
  PromptFragment,
} from '@cat-factory/contracts'
