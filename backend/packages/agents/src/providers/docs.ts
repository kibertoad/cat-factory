// ---------------------------------------------------------------------------
// Documentation URLs referenced by model-provisioning error remedies.
//
// The error-message coverage initiative embeds a documentation link alongside the human
// remedy of many failures. `@cat-factory/server` owns the canonical `config/docs.ts` for the
// boot/config layer, but the AI provisioning facade lives BELOW the server layer (server
// depends on agents, not the reverse), so it cannot import that module. This is the agents
// package's own small equivalent: the SINGLE place a provisioning remedy constructs an in-repo
// doc URL, so moving or renaming a doc is one edit here rather than a scatter of literals.
//
// In-repo docs are linked as stable GitHub blob URLs on `main` (they render on github.com and
// survive a shallow clone with no docs checked out). The remedy text stays self-sufficient
// without the link — the URL DEEPENS the instruction, it never replaces it.
// ---------------------------------------------------------------------------

/** The GitHub blob base for in-repo docs, pinned to `main` so the link is stable. */
const REPO_DOC_BLOB_BASE = 'https://github.com/kibertoad/cat-factory/blob/main'

/**
 * Build a stable GitHub blob URL to an in-repo doc on `main`, optionally deep-linked to a
 * section anchor. `path` is repo-relative (e.g. `backend/docs/model-support.md`); `anchor` is a
 * GitHub-slugified heading, appended as `#anchor` when provided.
 */
function repoDocUrl(path: string, anchor?: string): string {
  const base = `${REPO_DOC_BLOB_BASE}/${path}`
  return anchor ? `${base}#${anchor}` : base
}

/**
 * `backend/docs/model-support.md` — model providers, selection & provisioning. The single doc a
 * provisioning failure links; each helper deep-links a section. Add an entry here rather than a
 * bare literal at a throw site.
 */
export const MODEL_SUPPORT_DOCS = {
  /** The doc root — model selection, flavours, harnesses & provisioning. */
  root: () => repoDocUrl('backend/docs/model-support.md'),
  /** `## Provisioning per runtime` — how each facade composes its provider registry. */
  provisioning: () => repoDocUrl('backend/docs/model-support.md', '8-provisioning-per-runtime'),
  /** `### AWS Bedrock (opt-in)` — the Bedrock resolver + its `BEDROCK_MODELS` allow-list. */
  bedrock: () => repoDocUrl('backend/docs/model-support.md', 'aws-bedrock-opt-in'),
} as const
