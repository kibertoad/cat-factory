// ---------------------------------------------------------------------------
// Foundational services (backend/docs/adr/0031-foundational-services.md). Mirrors the
// `@cat-factory/contracts` schemas: the tiered catalog of shared capabilities an
// organisation already runs (file storage, notifications, audit …), each with its
// API contracts, plus the repo sources that feed it.
//
// Note `ApiContractSummary` (no body) and `ApiContractDocument` (with body) are two
// separate types on purpose — the catalog read never carries a document, and the
// management surface reads one only when a human opens it.
// ---------------------------------------------------------------------------
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  ApiContractDocument,
  ApiContractFormat,
  ApiContractSummary,
  CreateFoundationalServiceInput,
  FolderScanCoverage,
  FoundationalService,
  FoundationalServiceOwnerKind,
  FoundationalServiceSelection,
  FoundationalServiceSource,
  FoundationalServiceSourceMode,
  FoundationalServiceSourceStatus,
  FoundationalServiceSuppression,
  FoundationalServiceSyncResult,
  FoundationalServiceTier,
  LinkFoundationalServiceSourceInput,
  ResolvedFoundationalService,
  UpdateFoundationalServiceInput,
  UploadApiContract,
} from '@cat-factory/contracts'

// The SERVICE CATALOG connection: the developer portal (Backstage) whose services are imported
// into the catalog above as `workspace`-tier rows. Beside the catalog types rather than in a file
// of its own, because everything it produces IS that catalog.
export type {
  ConnectServiceCatalogInput,
  ServiceCatalogAuth,
  ServiceCatalogAuthMode,
  ServiceCatalogConnection,
  ServiceCatalogCoverage,
  ServiceCatalogProvider,
  ServiceCatalogSyncResult,
  ServiceCatalogSyncStatus,
} from '@cat-factory/contracts'
