import type {
  OrgSecretCipher,
  OrgSecretSourceOfArity,
  SealedConnectionOpenResult,
} from '@cat-factory/kernel'
import { UnavailableError, orgSecretRef } from '@cat-factory/kernel'

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

/**
 * What one named source's open produced (kernel's shared vocabulary, specialised here).
 *
 * `listBySources` answers PER SOURCE rather than rejecting as a batch, because the sources in one
 * call are independent facts about independent vendors: a corrupt Linear envelope says nothing
 * about the workspace's Jira connection, and a single rejection made every caller report the
 * healthy ones as broken too (a block's whole reply-channel map, a run's whole document corpus).
 * The point read {@link SealedConnectionStore.getByWorkspace} still THROWS, which is the honest
 * disposition where the caller asked about exactly one source and there is nothing else to answer.
 */
export type OpenedConnectionResult<Kind extends string> = SealedConnectionOpenResult<
  Kind,
  OpenedConnection<Kind>
>

/** The persistence port both integrations expose for their sealed connection rows. */
export interface SealedConnectionRepository<Kind extends string> {
  getByWorkspace(workspaceId: string, source: Kind): Promise<SealedConnectionRow<Kind> | null>
  listByWorkspace(workspaceId: string): Promise<SealedConnectionRow<Kind>[]>
  upsert(record: SealedConnectionRow<Kind>): Promise<void>
  softDelete(workspaceId: string, source: Kind, at: number): Promise<void>
}

export interface SealedConnectionStore<Kind extends string> {
  getByWorkspace(workspaceId: string, source: Kind): Promise<OpenedConnection<Kind> | null>
  listBySources(
    workspaceId: string,
    sources: readonly Kind[],
  ): Promise<OpenedConnectionResult<Kind>[]>
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
  /**
   * Which `ORG_SECRET_SOURCES` member addresses these rows on a mothership.
   *
   * Constrained to the ARITY-1 sources rather than the whole vocabulary, because every row this
   * store serves is addressed `(workspaceId, source)` and this generic factory never names a
   * member it could be checked against. That constraint is what lets {@link orgSecretRef} verify
   * the key below at build time: the earlier `OrgSecretSource` accepted a ref carrying no key at
   * all, which every hosted deployment tolerates (the cipher is local and the ref inert) and a
   * mothership-mode node refuses with a 422 on every open of every connection.
   */
  secretSource: OrgSecretSourceOfArity<1>
}

/**
 * A stored connection row exists but its sealed bag could not be opened.
 *
 * A `DomainError` rather than a bare `Error` so a controller answers 503 with a machine-readable
 * reason instead of a 500: the SPA maps the reason to copy that names the two real remedies (fix
 * the deployment's reach to its key, or re-connect the source), where a 500 names nothing. 503
 * rather than 409 because the two causes are indistinguishable from here on purpose — the
 * mothership collapses "no such row", "out of scope" and "nothing sealed there" into one uniform
 * 404 — and claiming a definite state we cannot see would be the same guess this seam removes.
 */
export class ConnectionCredentialsUnreadableError extends UnavailableError {
  constructor(
    readonly source: string,
    options?: { cause?: unknown },
  ) {
    super(
      `The stored ${source} connection credentials could not be read`,
      'connection_credentials_unreadable',
      { source },
    )
    this.name = 'ConnectionCredentialsUnreadableError'
    if (options && 'cause' in options) this.cause = options.cause
  }
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
    let plaintext: string
    try {
      // The row's OWN identity, not just its workspace: these rows are keyed `(workspace, source)`
      // and a mothership re-reads the authoritative row from the key it is handed. Built through
      // `orgSecretRef` so the arity is the compiler's problem rather than a table in another
      // package that this call site cannot see.
      plaintext = await orgSecrets.decryptFor(
        orgSecretRef(secretSource, row.workspaceId, row.source),
        row.credentialsCipher,
      )
    } catch (cause) {
      // Re-bound rather than propagated raw: a decrypt/transport failure here routinely quotes the
      // request URL or the value it choked on, and only the typed refusal carries the source a
      // caller has to attribute the gap to.
      throw new ConnectionCredentialsUnreadableError(row.source, { cause })
    }
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
      // Settled per row, never `Promise.all`: one unopenable bag is one source's fact, and letting
      // it reject the batch is what made a single corrupt row read to every caller as though the
      // workspace had no working connection at all.
      return Promise.all(
        rows.map(async (row): Promise<OpenedConnectionResult<Kind>> => {
          try {
            return { source: row.source, status: 'opened', connection: await open(row) }
          } catch (cause) {
            return { source: row.source, status: 'unreadable', cause }
          }
        }),
      )
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
  } catch (cause) {
    throw new ConnectionCredentialsUnreadableError(source, { cause })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConnectionCredentialsUnreadableError(source, {
      cause: new Error('the opened value is not a credential bag'),
    })
  }
  return parsed as Record<string, string>
}
