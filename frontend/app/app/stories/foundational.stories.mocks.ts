// Foundational services: the shared capabilities an organisation already runs, which an architect
// designs against. The account registers file storage (uploaded) and notifications (synced from a
// linked repository); the story board adds feature flags of its own; the deployment registers an
// audit log in code. The services, contracts, repositories and portal are made up.
import type {
  ApiContractDocument,
  ApiContractSummary,
  FoundationalService,
  FoundationalServiceSource,
  FoundationalServiceSuppression,
  ResolvedFoundationalService,
  ServiceCatalogConnection,
} from '@cat-factory/contracts'
import { orgAccount } from './accounts.stories.mocks'

const filesApi: ApiContractSummary = {
  contractId: 'files-api',
  format: 'openapi',
  title: 'Files API',
  size: 48_210,
  path: null,
  operations: ['GET /files/{id}', 'POST /files', 'DELETE /files/{id}'],
  omittedOperations: 0,
}

const notificationEvents: ApiContractSummary = {
  contractId: 'notification-events',
  format: 'asyncapi',
  title: 'Notification events',
  size: 12_480,
  path: 'services/notifications/asyncapi.yaml',
  operations: ['publish notification.requested', 'subscribe notification.delivered'],
  omittedOperations: 0,
}

/** One stored service, as the account's own tier lists it. */
export function foundationalService(
  overrides: Partial<FoundationalService> & Pick<FoundationalService, 'id' | 'name'>,
): FoundationalService {
  return {
    ownerKind: 'account',
    summary: '',
    description: '',
    capabilities: [],
    contracts: [],
    sourceId: null,
    sourcePath: null,
    pinnedCommit: null,
    createdAt: Date.UTC(2026, 8, 3),
    updatedAt: Date.UTC(2026, 9, 6),
    ...overrides,
  }
}

/** The account's two: file storage, uploaded, and notifications, synced from a repository. */
export const accountServices: FoundationalService[] = [
  foundationalService({
    id: 'file-storage',
    name: 'File storage',
    summary: 'Stores and serves user uploads, with signed download links.',
    description: 'Use it for any file a user uploads. It does not transform images.',
    capabilities: ['file-storage'],
    contracts: [filesApi],
  }),
  foundationalService({
    id: 'notifications',
    name: 'Notifications',
    summary: 'Sends email and push notifications from one request.',
    capabilities: ['notifications', 'email'],
    contracts: [notificationEvents],
    sourceId: 'fss_platform_services',
    sourcePath: 'services/notifications',
    pinnedCommit: '4e1c9a7',
  }),
]

/** The board's own: feature flags. */
export const workspaceServices: FoundationalService[] = [
  foundationalService({
    id: 'feature-flags',
    name: 'Feature flags',
    ownerKind: 'workspace',
    summary: 'Turns features on per customer without a deploy.',
    capabilities: ['feature-flags'],
  }),
]

/**
 * What an architect on the story board is handed: the deployment's audit log, the account's two
 * services and the board's own, each with the tier that won.
 */
export const resolvedCatalog: ResolvedFoundationalService[] = [
  {
    id: 'audit-log',
    name: 'Audit log',
    summary: 'Records who did what, for the compliance export.',
    description: '',
    capabilities: ['audit'],
    contracts: [],
    credentials: [{ key: 'AUDIT_LOG_TOKEN', usage: 'Write token for the audit API.' }],
    tier: 'builtin',
  },
  ...accountServices.map(({ id, name, summary, description, capabilities, contracts }) => ({
    id,
    name,
    summary,
    description,
    capabilities,
    contracts,
    tier: 'account' as const,
  })),
  ...workspaceServices.map(({ id, name, summary, description, capabilities, contracts }) => ({
    id,
    name,
    summary,
    description,
    capabilities,
    contracts,
    tier: 'workspace' as const,
  })),
]

/** The Files API document, as the lazy contract read returns it. */
export const filesApiDocument: ApiContractDocument = {
  ...filesApi,
  body: [
    'openapi: 3.1.0',
    'info:',
    '  title: Files API',
    '  version: 2.3.0',
    'paths:',
    '  /files/{id}:',
    '    get:',
    '      summary: Download a file',
    '    delete:',
    '      summary: Delete a file',
    '  /files:',
    '    post:',
    '      summary: Upload a file',
  ].join('\n'),
}

/**
 * What the board opts out of: the account's search service, and a tombstone that shadows nothing
 * now, because the account withdrew the service it hid.
 */
export const suppressions: FoundationalServiceSuppression[] = [
  {
    id: 'search',
    name: 'Search',
    summary: 'Full-text search over tickets and documents.',
    inherited: true,
  },
  { id: 'legacy-mailer', name: '', summary: '', inherited: false },
]

/** One linked source, synced. */
export function foundationalSource(
  overrides: Partial<FoundationalServiceSource> = {},
): FoundationalServiceSource {
  return {
    id: 'fss_platform_services',
    ownerKind: 'account',
    ownerId: orgAccount.id,
    repoOwner: 'acme',
    repoName: 'platform-services',
    gitRef: 'main',
    mode: 'directory',
    dirPath: 'services',
    recursive: false,
    filePaths: [],
    serviceId: null,
    serviceName: null,
    serviceSummary: null,
    lastSyncedCommit: '4e1c9a7',
    lastSyncedAt: Date.UTC(2026, 9, 11, 8, 0),
    createdAt: Date.UTC(2026, 8, 3),
    ...overrides,
  }
}

/** A directory of services, and a billing API linked by its one OpenAPI file, never synced. */
export const foundationalSources: FoundationalServiceSource[] = [
  foundationalSource(),
  foundationalSource({
    id: 'fss_billing',
    repoName: 'billing',
    mode: 'files',
    dirPath: '',
    filePaths: ['api/openapi.yaml'],
    serviceId: 'billing',
    serviceName: 'Billing',
    lastSyncedCommit: null,
    lastSyncedAt: null,
  }),
]

/** The story board's Backstage, imported in full on its last pass. */
export function serviceCatalogConnection(
  overrides: Partial<ServiceCatalogConnection> = {},
): ServiceCatalogConnection {
  return {
    provider: 'backstage',
    baseUrl: 'https://backstage.acme.dev',
    authMode: 'static-token',
    entityFilter: ['kind=component', 'spec.type=service'],
    includeApis: true,
    maxServices: 200,
    lastSyncedAt: Date.UTC(2026, 9, 12, 6, 0),
    lastSyncStatus: 'ok',
    lastSyncMessage: null,
    connectedAt: Date.UTC(2026, 9, 1),
    ...overrides,
  }
}
