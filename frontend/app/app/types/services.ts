// In-org shared services. Mirrors the `@cat-factory/contracts` `services` wire schemas:
// a `Service` is the account-owned unit of work (a service frame + its subtree + repo),
// shared across the workspaces that *mount* it; a `WorkspaceMount` places a service onto a
// workspace board with that board's own frame layout override.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type { Service, WorkspaceMount } from '@cat-factory/contracts'
