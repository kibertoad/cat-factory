// Per-workspace capability-credential shapes: the tenant-scoped home for the secrets a
// registered tool server (MCP) or generative binary integration declares BY NAME. Values are
// write-only — the view carries the keys the deployment DECLARES, which of them this workspace
// has stored, and which stored keys nothing declares any more.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  CapabilityCredentialRef,
  CapabilityCredentialStatus,
  CapabilityCredentialsView,
} from '@cat-factory/contracts'
