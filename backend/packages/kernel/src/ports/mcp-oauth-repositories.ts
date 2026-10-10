// Persistence port for the PER-WORKSPACE OAuth grants a remote (`http`) tool server needs — the
// tokens a board holds against a vendor's MCP server, and the machine tokens a client-credentials
// declaration mints on demand.
//
// Mirrors across the D1 (Cloudflare) and Drizzle/Postgres (Node) facades; runtime parity is
// mandatory. Values are sealed at rest by the facade's `SecretCipher` (info tag
// `cat-factory:mcp-oauth`), so the record carries the sealed blob and never a token — which is
// what lets it ride the mothership's persistence RPC, exactly like `CapabilityCredentialRepository`.
//
// ONE ROW PER (workspace, server), unlike the capability-credential store's one-blob-per-workspace.
// The shapes differ because the WRITES do: a credential row is edited by a human filling in a
// checklist, while a grant row is rewritten by a REFRESH on the dispatch path, and two dispatches
// refreshing two different servers at the same moment are the ordinary case rather than the
// pathological one. Per-server rows make those two writes touch different rows instead of
// contending on one; the rev then only has to settle a race between two refreshes of the SAME
// grant, which is what it is for.

/** One workspace's sealed OAuth grant for one tool server. */
export interface McpOAuthGrantRecord {
  workspaceId: string
  /** The tool server id the grant authorises (`McpServerDefinition.id`). */
  serverId: string
  /**
   * Sealed JSON of the token set: the access token, the refresh token when one was issued, the
   * absolute expiry and the granted scope. Opaque to everything but `McpOAuthService`, which
   * decrypts it to answer a dispatch and re-seals it after a refresh.
   */
  tokens: string
  /**
   * Non-secret display summary as JSON (`McpOAuthGrantSummary`), so the operator surface can say
   * what a board is connected to, when, by whom, and whether the last token exchange failed —
   * without decrypting anything.
   */
  summary: string
  /**
   * Optimistic-concurrency revision, bumped on every write. Two dispatches can reach an expired
   * access token at the same instant and both try to refresh it; the rev is what makes one of them
   * the writer and lets the other adopt the winner's tokens instead of overwriting them with a
   * token set minted from a refresh token the server has already rotated away.
   */
  rev: number
  createdAt: number
  updatedAt: number
}

export interface McpOAuthGrantRepository {
  get(workspaceId: string, serverId: string): Promise<McpOAuthGrantRecord | null>
  /**
   * Every grant a workspace holds.
   *
   * The read the operator surface uses, and the reason it exists rather than a `get` per row: the
   * tool-server inventory renders one row per DECLARED server and each needs its connection state,
   * so a per-server read there is an N+1 over a list whose length is the deployment's whole
   * registry.
   */
  listByWorkspace(workspaceId: string): Promise<McpOAuthGrantRecord[]>
  /**
   * Blind write, for the two paths whose semantics ARE last-writer-wins: completing an
   * authorization (a human just granted, and what they granted supersedes whatever was stored) and
   * the first mint of a client-credentials token. Inserts with the record's `rev`; on conflict the
   * STORED rev is bumped in SQL, so it stays monotonic and a concurrent `compareAndSwap` whose
   * base predates this write reliably loses.
   */
  upsert(record: McpOAuthGrantRecord): Promise<void>
  /**
   * Rev-guarded conditional write, for the REFRESH path: persists `record` only if the stored row
   * still carries `expectedRev`. `expectedRev: null` means "expect NO row" (a conflict-do-nothing
   * insert). False ⇒ another writer refreshed first, and the caller re-reads and uses THEIR tokens
   * rather than re-applying its own — a rotated refresh token makes the loser's token set the
   * stale one, so "reload and re-apply" would replace a working grant with a dead one.
   */
  compareAndSwap(record: McpOAuthGrantRecord, expectedRev: number | null): Promise<boolean>
  /** Disconnect: drop the grant. The next dispatch reports the server as `oauth_not_connected`. */
  delete(workspaceId: string, serverId: string): Promise<void>
}
