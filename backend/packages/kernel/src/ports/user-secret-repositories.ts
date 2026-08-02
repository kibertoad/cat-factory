import type { UserSecretKind } from '../domain/types.js'

// Persistence port for generic per-USER secrets — token-style credentials keyed by
// `(userId, kind)` (a GitHub PAT today; future repository/provider tokens as new
// kinds). The secret is single-system-key ciphertext (`secretCipher`); non-secret
// fields ride in `metadataJson`. Both runtimes (Cloudflare D1 + Node/local Postgres)
// implement this so the behaviour is identical everywhere.

/** A user's stored secret of one kind, at rest. */
export interface UserSecretRecord {
  /** Internal user id (`usr_*`) of the owner. */
  userId: string
  /** Which secret this is (`github_pat`, …); maps to a registered kind handler. */
  kind: UserSecretKind
  /** Display label (defaults to the kind's name when the user leaves it blank). */
  label: string
  /** System-key ciphertext of the raw secret. */
  secretCipher: string
  /** JSON of non-secret metadata the kind understands (e.g. `{"apiBase":"…"}`), or null. */
  metadataJson: string | null
  createdAt: number
  updatedAt: number
}

export interface UserSecretRepository {
  /** Every secret the user has stored. */
  listByUser(userId: string): Promise<UserSecretRecord[]>
  /** The user's secret of a kind, or null. */
  getByUserKind(userId: string, kind: UserSecretKind): Promise<UserSecretRecord | null>
  /** Insert or replace the user's secret of a kind (one per user+kind). */
  upsert(record: UserSecretRecord): Promise<void>
  /** Remove the user's secret of a kind. */
  remove(userId: string, kind: UserSecretKind): Promise<void>
}

/**
 * Resolve the run initiator's stored GitHub PAT (decrypted), or null when they have
 * none. The facade-supplied seam the container executor's token mint + the engine
 * GitHub client consult to prefer the initiator's PAT over the deployment default.
 */
export type ResolveUserGitHubToken = (userId: string) => Promise<string | null>

/**
 * Which credential a run's outbound provider calls should be attributed to: WHO started it,
 * and WHICH workspace's policy governs whether that person's own token may be used at all.
 *
 * The workspace is not decoration. `allowInitiatorPat` is a per-workspace switch, so the
 * initiator alone cannot answer "may this run push as them" — and resolving the workspace
 * downstream from the installation id would be ambiguous (one installation can serve several
 * workspaces) exactly where the answer must not be guessed.
 */
export interface RunCredentialScope {
  /** The user who started the run; absent/null for a run nobody is attributed to. */
  initiatedBy?: string | null
  /** The workspace the run belongs to — what the credential policy is resolved against. */
  workspaceId: string
}

/**
 * Run `fn` with the run's credential scope in ambient context, so the engine GitHub client can
 * prefer the initiator's PAT (where the workspace permits it). The real implementation is
 * AsyncLocalStorage-backed and lives in a facade-facing package (it needs a runtime that has
 * `node:async_hooks`); the engine receives it as an injected seam and defaults to a
 * pass-through (`(_, fn) => fn()`), so tests/conformance run unchanged. Pure type only — no
 * runtime import here.
 */
export type RunInitiatorScope = <T>(scope: RunCredentialScope, fn: () => T) => T
