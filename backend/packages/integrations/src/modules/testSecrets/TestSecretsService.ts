import type {
  BlockRepository,
  Clock,
  SecretCipher,
  TestSecretsRepository,
} from '@cat-factory/kernel'
import type {
  ServiceTestSecretsView,
  TestSecretEntry,
  TestSecretRef,
  UpsertServiceTestSecretsInput,
} from '@cat-factory/contracts'
import { parseTestSecretEntries, serviceTestSecretsSummary } from '@cat-factory/contracts'

/**
 * HKDF domain tag separating the sealed test-secret blob from every other cipher (mirrors
 * {@link OBSERVABILITY_CIPHER_INFO} et al). The facade builds a `WebCryptoSecretCipher` keyed
 * by `ENCRYPTION_KEY` with this info tag.
 */
export const TEST_SECRETS_CIPHER_INFO = 'cat-factory:test-secrets'

export interface TestSecretsServiceDependencies {
  testSecretsRepository: TestSecretsRepository
  /** Seals the `TestSecretEntry[]` blob at rest (domain tag {@link TEST_SECRETS_CIPHER_INFO}). */
  secretCipher: SecretCipher
  /** Walks a run's block up to its service frame (the secrets are keyed by the frame). */
  blockRepository: BlockRepository
  clock: Clock
}

/**
 * Owns the SENSITIVE per-service test credentials — the sealed sibling of the non-sensitive
 * `ServiceTestCredentials` pools. Secrets are keyed by SERVICE FRAME block and sealed at rest
 * (a `TestSecretEntry[]` blob) alongside a non-secret summary (the `TestSecretRef[]`).
 *
 * The CRUD surface ({@link getView}/{@link set}/{@link deleteFor}) operates on the exact frame
 * block id the inspector edits and NEVER returns a value. The resolution surface
 * ({@link resolveRefsForBlock}/{@link resolveValuesForBlock}) walks a run's task block up to its
 * service frame: the engine reads the REFS (key + description) to advertise them in the tester
 * prompt, and the executor reads the VALUES at dispatch to inject them into the container
 * environment out of band — the values never touch a prompt or the telemetry snapshot.
 */
export class TestSecretsService {
  private readonly repo: TestSecretsRepository
  private readonly cipher: SecretCipher
  private readonly blocks: BlockRepository
  private readonly clock: Clock

  constructor(deps: TestSecretsServiceDependencies) {
    this.repo = deps.testSecretsRepository
    this.cipher = deps.secretCipher
    this.blocks = deps.blockRepository
    this.clock = deps.clock
  }

  /** The configured secrets for a service frame, as key + description refs (never values). */
  async getView(workspaceId: string, blockId: string): Promise<ServiceTestSecretsView> {
    const record = await this.repo.getByBlock(workspaceId, blockId)
    return { blockId, entries: record ? this.parseRefs(record.summary) : [] }
  }

  /**
   * Set/replace a service frame's sensitive test secrets. An empty set deletes the row (a
   * service with no secrets carries none), so a cleared inspector leaves nothing sealed.
   */
  async set(
    workspaceId: string,
    blockId: string,
    input: UpsertServiceTestSecretsInput,
  ): Promise<ServiceTestSecretsView> {
    if (input.entries.length === 0) {
      await this.repo.deleteByBlock(workspaceId, blockId)
      return { blockId, entries: [] }
    }
    const now = this.clock.now()
    const existing = await this.repo.getByBlock(workspaceId, blockId)
    const credentials = await this.cipher.encrypt(JSON.stringify(input.entries))
    const summary = serviceTestSecretsSummary(input.entries)
    await this.repo.upsert({
      workspaceId,
      blockId,
      credentials,
      summary: JSON.stringify(summary),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    return { blockId, entries: summary }
  }

  /** Remove a service frame's sensitive test secrets. */
  async deleteFor(workspaceId: string, blockId: string): Promise<void> {
    await this.repo.deleteByBlock(workspaceId, blockId)
  }

  /**
   * The NON-secret refs (key + description) configured for a run block's service frame — what
   * the engine folds into the tester prompt so the agent knows which env vars are available and
   * what each is for. Walks up to the frame; decrypts nothing. Empty when the service has none.
   */
  async resolveRefsForBlock(workspaceId: string, blockId: string): Promise<TestSecretRef[]> {
    const frameId = await this.resolveServiceFrameId(workspaceId, blockId)
    if (!frameId) return []
    const record = await this.repo.getByBlock(workspaceId, frameId)
    return record ? this.parseRefs(record.summary) : []
  }

  /**
   * The full (DECRYPTED) test secrets configured for a run block's service frame — the values
   * the executor injects into the Tester container's environment out of band. Walks up to the
   * frame and decrypts the sealed blob. Empty when the service has none. This is the ONLY place
   * a value is decrypted, and its result must never be put on a prompt or the telemetry snapshot.
   */
  async resolveValuesForBlock(workspaceId: string, blockId: string): Promise<TestSecretEntry[]> {
    const frameId = await this.resolveServiceFrameId(workspaceId, blockId)
    if (!frameId) return []
    const record = await this.repo.getByBlock(workspaceId, frameId)
    if (!record) return []
    return parseTestSecretEntries(JSON.parse(await this.cipher.decrypt(record.credentials)))
  }

  /** Parse the persisted non-secret summary JSON back into refs (tolerating a corrupt row). */
  private parseRefs(summary: string): TestSecretRef[] {
    try {
      const parsed = JSON.parse(summary) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (e): e is TestSecretRef =>
          !!e && typeof e === 'object' && typeof (e as TestSecretRef).key === 'string',
      )
    } catch {
      return []
    }
  }

  /**
   * The service-frame id for a block — walks up frame → module → task, cycle-guarded, mirroring
   * the engine's `resolveServiceFrame`. Returns the frame's id (or the topmost block reached).
   */
  private async resolveServiceFrameId(
    workspaceId: string,
    blockId: string,
  ): Promise<string | null> {
    let current = await this.blocks.get(workspaceId, blockId)
    for (let i = 0; current && i < 8; i++) {
      if (current.level === 'frame' || !current.parentId) return current.id
      current = await this.blocks.get(workspaceId, current.parentId)
    }
    return current?.id ?? null
  }
}
