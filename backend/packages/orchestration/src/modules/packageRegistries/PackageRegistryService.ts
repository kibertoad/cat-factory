import type {
  Clock,
  IdGenerator,
  PackageRegistryConnectionRepository,
  SecretCipher,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { NotFoundError, requireWorkspace } from '@cat-factory/kernel'
import type {
  AddPackageRegistryInput,
  PackageRegistryEntry,
  PackageRegistryListView,
} from '@cat-factory/contracts'
import {
  packageRegistryHost,
  packageRegistrySummary,
  parsePackageRegistryEntries,
  parsePackageRegistrySummary,
} from '@cat-factory/contracts'

/** HKDF domain-separation tag for the sealed registry entries (see WebCryptoSecretCipher). */
export const PACKAGE_REGISTRY_CIPHER_INFO = 'cat-factory:package-registries'

export interface PackageRegistryServiceDependencies {
  packageRegistryConnectionRepository: PackageRegistryConnectionRepository
  /** Seals the registry tokens at rest (domain tag 'cat-factory:package-registries'). */
  packageRegistrySecretCipher: SecretCipher
  workspaceRepository: WorkspaceRepository
  clock: Clock
  idGenerator: IdGenerator
}

/**
 * The registry spec forwarded on a container job body: host derived from the fixed
 * vendor set (never user-supplied), decrypted token included. The harness renders
 * these into `~/.npmrc` before the agent runs.
 */
export interface DispatchPackageRegistry {
  ecosystem: 'npm'
  host: string
  scopes: string[]
  token: string
}

/**
 * Manages a workspace's private package-registry entries (npm private orgs, GitHub
 * Packages): all entries sealed at rest as one JSON blob and never read back — the
 * list view renders from the persisted non-secret summary. The tokens only leave the
 * cipher in `resolveForDispatch`, on their way onto a container job body.
 */
export class PackageRegistryService {
  private readonly connections: PackageRegistryConnectionRepository
  private readonly cipher: SecretCipher
  private readonly workspaceRepository: WorkspaceRepository
  private readonly clock: Clock
  private readonly idGenerator: IdGenerator

  constructor(deps: PackageRegistryServiceDependencies) {
    this.connections = deps.packageRegistryConnectionRepository
    this.cipher = deps.packageRegistrySecretCipher
    this.workspaceRepository = deps.workspaceRepository
    this.clock = deps.clock
    this.idGenerator = deps.idGenerator
  }

  /** The workspace's registry entries, redacted (never returns a token). */
  async list(workspaceId: string): Promise<PackageRegistryListView> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const connection = await this.connections.get(workspaceId)
    if (!connection) return { entries: [] }
    return { entries: parsePackageRegistrySummary(JSON.parse(connection.summary)) }
  }

  /** Add one registry entry, re-sealing the whole entry list at rest. */
  async add(workspaceId: string, input: AddPackageRegistryInput): Promise<PackageRegistryListView> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = await this.connections.get(workspaceId)
    const entries = existing ? await this.decryptEntries(existing.entries) : []
    entries.push({
      id: this.idGenerator.next('pkgreg'),
      ecosystem: input.ecosystem,
      vendor: input.vendor,
      scopes: input.scopes,
      token: input.token,
    })
    await this.persist(workspaceId, entries, existing?.createdAt)
    return { entries: packageRegistrySummary(entries) }
  }

  /** Remove one entry; the row is deleted outright when the last entry goes. */
  async remove(workspaceId: string, entryId: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = await this.connections.get(workspaceId)
    const entries = existing ? await this.decryptEntries(existing.entries) : []
    const remaining = entries.filter((entry) => entry.id !== entryId)
    if (remaining.length === entries.length) {
      throw new NotFoundError('PackageRegistryEntry', entryId)
    }
    if (remaining.length === 0) {
      await this.connections.delete(workspaceId)
      return
    }
    await this.persist(workspaceId, remaining, existing?.createdAt)
  }

  /**
   * Decrypt the workspace's entries for a container dispatch. Called by the agent
   * executor's `resolvePackageRegistries` seam; a failure here PROPAGATES — a
   * workspace that configured private registries must not silently run without them.
   */
  async resolveForDispatch(workspaceId: string): Promise<DispatchPackageRegistry[]> {
    return resolvePackageRegistriesForDispatch(this.connections, this.cipher, workspaceId)
  }

  private async decryptEntries(sealed: string): Promise<PackageRegistryEntry[]> {
    return decryptRegistryEntries(this.cipher, sealed)
  }

  private async persist(
    workspaceId: string,
    entries: PackageRegistryEntry[],
    createdAt?: number,
  ): Promise<void> {
    const now = this.clock.now()
    await this.connections.upsert({
      workspaceId,
      entries: await this.cipher.encrypt(JSON.stringify(entries)),
      summary: JSON.stringify(packageRegistrySummary(entries)),
      createdAt: createdAt ?? now,
      updatedAt: now,
    })
  }
}

async function decryptRegistryEntries(
  cipher: SecretCipher,
  sealed: string,
): Promise<PackageRegistryEntry[]> {
  return parsePackageRegistryEntries(JSON.parse(await cipher.decrypt(sealed)))
}

/**
 * Standalone dispatch-time resolution over the raw repo + cipher, so a facade can wire
 * the agent executor's `resolvePackageRegistries` seam without constructing the full
 * management service (the executor is built before the core container). The service's
 * `resolveForDispatch` delegates here — one code path, two entry points.
 */
export async function resolvePackageRegistriesForDispatch(
  repository: PackageRegistryConnectionRepository,
  cipher: SecretCipher,
  workspaceId: string,
): Promise<DispatchPackageRegistry[]> {
  const connection = await repository.get(workspaceId)
  if (!connection) return []
  const entries = await decryptRegistryEntries(cipher, connection.entries)
  return entries.map((entry) => ({
    ecosystem: entry.ecosystem,
    host: packageRegistryHost(entry.vendor),
    scopes: entry.scopes,
    token: entry.token,
  }))
}
