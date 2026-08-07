import type { OrgSecretCipher, OrgSecretSource } from '@cat-factory/kernel'

// The shared implementation behind `DocumentConnectionStore` and `TaskConnectionStore`: the ONE
// place a document-source or tracker credential bag is sealed or opened.
//
// Both integrations store the identical row (workspace, source, sealed bag, label) and differ
// only in their source vocabulary and HKDF domain, so one generic factory serves both rather
// than two copies whose failure dispositions drift. It is generic over the source kind alone;
// nothing here knows what a Figma token or a Jira API token is.
//
// Why the seal lives in the row rather than inside the repository (which is where these two
// integrations used to open it): a repository that decrypts can only be called by a process
// holding the key, which is exactly why the document/task connection surfaces were the last
// integration parked off the mothership persistence RPC. With the envelope as the row's own
// value, the row travels like every other sealed connection (environments, observability, Slack,
// runner pools) and a mothership-mode node opens it by NAMING the row over
// `/internal/secrets/unseal` — see `docs/initiatives/mothership-mode.md`.

/** The stored row, generic over the integration's source vocabulary. */
export interface SealedConnectionRow<Kind extends string> {
  workspaceId: string
  source: Kind
  credentialsCipher: string
  label: string
  createdAt: number
  deletedAt: number | null
}

/** The same row with its bag opened. */
export interface OpenedConnection<Kind extends string> {
  workspaceId: string
  source: Kind
  credentials: Record<string, string>
  label: string
  createdAt: number
  deletedAt: number | null
}

/** The non-secret half, which `listSummaries` answers without opening anything. */
export interface ConnectionSummary<Kind extends string> {
  workspaceId: string
  source: Kind
  label: string
  createdAt: number
}

/** The persistence port both integrations expose for their sealed connection rows. */
export interface SealedConnectionRepository<Kind extends string> {
  getByWorkspace(workspaceId: string, source: Kind): Promise<SealedConnectionRow<Kind> | null>
  listByWorkspace(workspaceId: string): Promise<SealedConnectionRow<Kind>[]>
  upsert(record: SealedConnectionRow<Kind>): Promise<void>
  softDelete(workspaceId: string, source: Kind, at: number): Promise<void>
}

export interface SealedConnectionStore<Kind extends string> {
  getByWorkspace(workspaceId: string, source: Kind): Promise<OpenedConnection<Kind> | null>
  listBySources(workspaceId: string, sources: readonly Kind[]): Promise<OpenedConnection<Kind>[]>
  listSummaries(workspaceId: string): Promise<ConnectionSummary<Kind>[]>
  upsert(record: OpenedConnection<Kind>): Promise<void>
  softDelete(workspaceId: string, source: Kind, at: number): Promise<void>
}

export interface SealedConnectionStoreDependencies<Kind extends string> {
  repository: SealedConnectionRepository<Kind>
  /**
   * The deployment's cipher for this integration's HKDF domain, composed with a mothership
   * delegate where one is wired (`createOrgSecretCipher`). With no delegate this is the local
   * key, byte-for-byte the prior behaviour.
   */
  orgSecrets: OrgSecretCipher
  /** Which `ORG_SECRET_SOURCES` member addresses these rows on a mothership. */
  secretSource: OrgSecretSource
}

/**
 * Build the opening view of a sealed connection repository.
 *
 * A bag that cannot be opened THROWS, and that is a change from the repositories this replaces,
 * which answered a failed decrypt with an empty bag so "the import path fails closed". An empty
 * bag is indistinguishable from a connection saved with no credentials, so every caller had to
 * re-derive the difference from whatever the provider said next: the refusal arrived as a vendor
 * 401. Throwing is what lets one caller report `credentials_unreadable` and another report the
 * source as unreachable, which are two different fixes.
 */
export function createSealedConnectionStore<Kind extends string>(
  deps: SealedConnectionStoreDependencies<Kind>,
): SealedConnectionStore<Kind> {
  const { repository, orgSecrets, secretSource } = deps

  const open = async (row: SealedConnectionRow<Kind>): Promise<OpenedConnection<Kind>> => {
    const plaintext = await orgSecrets.decryptFor(
      { source: secretSource, workspaceId: row.workspaceId },
      row.credentialsCipher,
    )
    const { credentialsCipher: _sealed, ...rest } = row
    return { ...rest, credentials: parseCredentials(plaintext, row.source) }
  }

  return {
    async getByWorkspace(workspaceId, source) {
      const row = await repository.getByWorkspace(workspaceId, source)
      return row ? open(row) : null
    },

    async listBySources(workspaceId, sources) {
      if (sources.length === 0) return []
      const wanted = new Set<Kind>(sources)
      // ONE stored-row read, then an open per source the caller named — never per stored row.
      // A workspace's shelf legitimately holds sources a given corpus says nothing about, and on
      // a mothership-mode node each open is a round trip.
      const rows = (await repository.listByWorkspace(workspaceId)).filter((row) =>
        wanted.has(row.source),
      )
      return Promise.all(rows.map(open))
    },

    async listSummaries(workspaceId) {
      const rows = await repository.listByWorkspace(workspaceId)
      return rows.map(({ workspaceId: ws, source, label, createdAt }) => ({
        workspaceId: ws,
        source,
        label,
        createdAt,
      }))
    },

    async upsert(record) {
      const { credentials, ...rest } = record
      const credentialsCipher = await orgSecrets.encryptFor(
        { source: secretSource, workspaceId: record.workspaceId },
        JSON.stringify(credentials),
      )
      await repository.upsert({ ...rest, credentialsCipher })
    },

    softDelete(workspaceId, source, at) {
      return repository.softDelete(workspaceId, source, at)
    },
  }
}

/**
 * The opened plaintext as a credential bag.
 *
 * A bag that decrypted but does not parse is a corrupt row rather than an absent credential, so
 * it throws for the same reason a failed decrypt does: the empty object it used to become read
 * downstream as "connected, with nothing in it".
 */
function parseCredentials(plaintext: string, source: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error(`The stored ${source} connection credentials are not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`The stored ${source} connection credentials are not a credential bag`)
  }
  return parsed as Record<string, string>
}
