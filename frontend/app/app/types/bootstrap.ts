// ---------------------------------------------------------------------------
// Repo-bootstrap domain types. Mirrors the `@cat-factory/contracts` bootstrap
// schemas so backend payloads drop straight into the Pinia store.
//
// A "reference architecture" is a managed base repo (an opinionated starter the
// org wants new services to follow); the "bootstrap repo" task creates a new repo
// from one and runs a bootstrapper agent in a container to adapt it.
// ---------------------------------------------------------------------------
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  ReferenceArchitecture,
  CreateReferenceArchitectureInput,
  UpdateReferenceArchitectureInput,
  BootstrapStatus,
  BootstrapFailureKind,
  BootstrapFailure,
  BootstrapJob,
  BootstrapRepoInput,
} from '@cat-factory/contracts'
