import type {
  DelegatedSealRef,
  DelegatedSecretRef,
  OrgSecretSource,
  SecretDelegate,
} from '@cat-factory/kernel'

// Mothership-mode SECRET DELEGATION: the wire envelope + the fetch-based client half
// (docs/initiatives/mothership-mode.md, the secrets-delegation slice).
//
// The server half is `SecretDelegationController`; this module is what a laptop composes into
// `createOrgSecretCipher` so that every org-owned sealed credential it reads or writes is opened
// and sealed by the mothership, under the mothership's key. It is the deliberate counterpart of
// the persistence RPC, the GitHub token mint and the notification relay: ADR 0009 records that a
// cross-cutting concern gets its OWN `/internal/*` endpoint rather than falling out of the
// persistence proxy, and this one could not have ridden that proxy in any case: the persistence
// registry resolves a REPOSITORY, and no repository method returns a plaintext credential.

/** `POST /internal/secrets/unseal`: identifies the ROW, never the ciphertext. */
export interface DelegatedUnsealRequest {
  source: OrgSecretSource
  workspaceId: string
  /**
   * Trailing identifier args of the source's declared read, in declaration order. How many the
   * source takes is kernel's `ORG_SECRET_KEY_ARITY`, which both halves read: the node builds this
   * through `orgSecretRef` and the endpoint rejects a list that disagrees.
   */
  key?: readonly (string | null)[]
}

export interface DelegatedUnsealResponse {
  ok: true
  plaintext: string
}

/** `POST /internal/secrets/seal`. No row read: a seal depends on the key, not on stored state. */
export interface DelegatedSealRequest {
  source: OrgSecretSource
  workspaceId: string
  plaintext: string
}

export interface DelegatedSealResponse {
  ok: true
  envelope: string
}

export interface HttpSecretDelegateOptions {
  baseUrl: string
  /** The machine token, as a fixed string OR a provider read per request (may return null). */
  token: string | (() => string | null)
  fetchImpl?: typeof fetch
  /**
   * Abort the round-trip after this long. An unseal sits INSIDE a provisioning step or a gate
   * probe, so an unreachable mothership must fail fast rather than hold the run open.
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Raised when the node holds no machine token yet (booted before the mothership login completed).
 *
 * A distinct error rather than a null answer, for the reason the telemetry sweep learned the hard
 * way: a client that returns an empty/zero value where it cannot reach the mothership is read by
 * its caller as a real answer. Here that would mean provisioning against an EMPTY credential
 * bundle, or reporting a monitor as unconfigured. Both silent, both wrong.
 */
export class MachineSecretDelegationUnavailableError extends Error {
  constructor(message = 'no mothership machine token: cannot delegate secret access') {
    super(message)
    this.name = 'MachineSecretDelegationUnavailableError'
  }
}

/**
 * A fetch-based {@link SecretDelegate} that opens and seals org secrets on a mothership,
 * presenting the node's machine token. Mirrors `HttpPersistenceRpcClient`'s auth contract (a fixed
 * token OR a per-request provider, so a token the SPA login caches after boot is picked up with no
 * restart).
 *
 * Every failure REJECTS. There is no degraded answer available: a credential that cannot be
 * opened is not an empty credential, and a value that cannot be sealed under the org key must not
 * silently be sealed under a local one.
 */
export class HttpSecretDelegate implements SecretDelegate {
  constructor(private readonly opts: HttpSecretDelegateOptions) {}

  async unseal(ref: DelegatedSecretRef): Promise<string> {
    const body: DelegatedUnsealRequest = {
      source: ref.source,
      workspaceId: ref.workspaceId,
      ...(ref.key ? { key: ref.key } : {}),
    }
    const res = await this.post<DelegatedUnsealResponse>('unseal', body)
    if (typeof res.plaintext !== 'string') {
      throw new Error('mothership secret unseal returned no plaintext')
    }
    return res.plaintext
  }

  async seal(ref: DelegatedSealRef, plaintext: string): Promise<string> {
    const body: DelegatedSealRequest = {
      source: ref.source,
      workspaceId: ref.workspaceId,
      plaintext,
    }
    const res = await this.post<DelegatedSealResponse>('seal', body)
    if (typeof res.envelope !== 'string' || res.envelope.length === 0) {
      throw new Error('mothership secret seal returned no envelope')
    }
    return res.envelope
  }

  private async post<T>(route: 'seal' | 'unseal', body: unknown): Promise<T> {
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    if (!token) throw new MachineSecretDelegationUnavailableError()
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const res = await fetchImpl(
      `${this.opts.baseUrl.replace(/\/$/, '')}/internal/secrets/${route}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    )
    if (!res.ok) {
      // The status is deliberately all the detail that travels: a 404 covers "out of scope",
      // "no such row" and "nothing sealed there" uniformly on the server side, and re-deriving
      // a distinction here would invent one the mothership refused to make.
      throw new Error(`mothership secret ${route} failed with HTTP ${res.status}`)
    }
    return (await res.json()) as T
  }
}
