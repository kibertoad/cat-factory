// ---------------------------------------------------------------------------
// Documentation / vendor URLs referenced by this package's error remedies.
//
// The error-message-coverage initiative embeds a documentation link alongside the human remedy
// of many failures. `@cat-factory/server` owns the canonical `config/docs.ts` (repoDocUrl + the
// DOCS registry), but `@cat-factory/integrations` sits BELOW the server layer and cannot import
// it — so, per the doc-URL convention, this package keeps its own small equivalent. Extend the
// `DOCS` table (or add a vendor constant) here rather than writing a bare
// `https://github.com/.../blob/main/...` literal at a throw site, so a docs move is one edit.
//
// In-repo docs are linked as stable GitHub blob URLs on `main`; the remedy text stays
// self-sufficient without the link — the URL DEEPENS the instruction, it never replaces it.
// ---------------------------------------------------------------------------

/** The GitHub blob base for in-repo docs, pinned to `main` so the link is stable. */
const REPO_DOC_BLOB_BASE = 'https://github.com/kibertoad/cat-factory/blob/main'

/** Build a stable GitHub blob URL to an in-repo doc on `main` (path is repo-relative). */
function repoDocUrl(path: string): string {
  return `${REPO_DOC_BLOB_BASE}/${path}`
}

/** Named in-repo docs referenced by this package's error remedies. */
export const DOCS = {
  /** `backend/docs/runner-pool-integration.md` — self-hosted runner pools + manifests. */
  runnerPool: () => repoDocUrl('backend/docs/runner-pool-integration.md'),
} as const

/**
 * Off-platform vendor URLs a remedy points at when the fix lives in the vendor's own console
 * rather than in-repo docs (Datadog keys are entered in the cat-factory UI, but they are MINTED
 * in Datadog's org settings).
 */
export const VENDOR_DOCS = {
  /** Datadog: where an operator mints/rotates the API + Application keys. */
  datadogApiKeys: 'https://app.datadoghq.com/organization-settings/api-keys',
} as const
