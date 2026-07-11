// ---------------------------------------------------------------------------
// Documentation URLs referenced by error remedies.
//
// The error-message coverage initiative embeds a documentation link alongside the human
// remedy of many failures, so the person who hits one can jump straight to the reference.
// This module is the SINGLE place in-repo doc URLs are constructed: a remedy names a doc via
// the {@link DOCS} helpers instead of hand-writing a `https://github.com/.../blob/main/...`
// literal, so moving or renaming a doc is one edit here rather than a scatter of string
// surgery across every throw site.
//
// In-repo docs are linked as stable GitHub blob URLs on `main` (they render on github.com and
// survive a shallow clone that has no docs checked out). The remedy text stays self-sufficient
// without the link — the URL DEEPENS the instruction, it never replaces it.
// ---------------------------------------------------------------------------

/** The GitHub blob base for in-repo docs, pinned to `main` so the link is stable. */
const REPO_DOC_BLOB_BASE = 'https://github.com/kibertoad/cat-factory/blob/main'

/**
 * Build a stable GitHub blob URL to an in-repo doc on `main`, optionally deep-linked to a
 * section anchor. `path` is repo-relative (e.g. `docs/environment-variables.md`); `anchor` is a
 * GitHub-slugified heading (e.g. `authentication`), appended as `#anchor` when provided.
 */
export function repoDocUrl(path: string, anchor?: string): string {
  const base = `${REPO_DOC_BLOB_BASE}/${path}`
  return anchor ? `${base}#${anchor}` : base
}

/**
 * Named in-repo docs referenced by error remedies. Each helper takes an optional section anchor.
 * Add an entry here (rather than a bare literal at the call site) whenever a new remedy links a
 * doc, so the doc's canonical URL lives in exactly one place.
 */
export const DOCS = {
  /** `docs/environment-variables.md` — the canonical target for every env-var remedy. */
  envVars: (anchor?: string) => repoDocUrl('docs/environment-variables.md', anchor),
  /** `backend/docs/model-support.md` — model providers + routing. */
  modelSupport: (anchor?: string) => repoDocUrl('backend/docs/model-support.md', anchor),
  /** `backend/docs/github-integration.md` — GitHub connect / repo linking. */
  githubIntegration: (anchor?: string) => repoDocUrl('backend/docs/github-integration.md', anchor),
  /** `backend/docs/github-operations.md` — GitHub App auth + operations. */
  githubOperations: (anchor?: string) => repoDocUrl('backend/docs/github-operations.md', anchor),
  /** `backend/docs/vcs-providers.md` — provider-neutral VCS layer (GitHub + GitLab). */
  vcsProviders: (anchor?: string) => repoDocUrl('backend/docs/vcs-providers.md', anchor),
  /** `backend/docs/concurrency-and-redis.md` — Redis cross-node realtime propagation. */
  concurrencyAndRedis: (anchor?: string) =>
    repoDocUrl('backend/docs/concurrency-and-redis.md', anchor),
} as const

// GitHub slugifies a heading by lowercasing, dropping punctuation, and turning runs of spaces
// into hyphens — so `## Storage & retention` becomes `storage--retention` (the `&` is dropped,
// leaving a double space → double hyphen). These constants name the section anchors the env-var
// remedies deep-link to, keeping the slug rules in one spot.
export const ENV_VARS_ANCHORS = {
  coreServiceNetworking: 'core-service--networking',
  authentication: 'authentication',
  vcsIntegration: 'vcs-integration-github--gitlab',
  modelProviders: 'model-providers',
  storageRetention: 'storage--retention',
} as const
