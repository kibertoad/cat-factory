// Private package-registry settings shapes. Per-workspace registry entries (npm
// private orgs, GitHub Packages) whose tokens are write-only — the list view only
// ever carries the non-secret summary (vendor + scopes + token tail).
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  PackageEcosystem,
  PackageRegistryVendor,
  AddPackageRegistryInput,
  PackageRegistryEntryView,
  PackageRegistryListView,
} from '@cat-factory/contracts'
