// Deterministic extraction of explicitly-named cross-references from prose, with no
// LLM and no live network call. The engine uses this to find references a task's
// description (or its incorporated requirements doc) names explicitly — a Jira key
// like `PROJ-123`, a GitHub `#12`/`owner/repo#12`, or a URL — and then resolves each
// against the documents/tasks ALREADY imported for the workspace. Only resolvable,
// explicitly-named refs become extra agent context: high-confidence by construction,
// so unresolved noise (e.g. `UTF-8` matching the Jira shape) is simply dropped at the
// resolution step rather than fetched. Pure + source-agnostic so it stays trivially
// testable; the URL host/shape matching against known sources lives at resolution.

export interface ExtractedReferences {
  /** Jira-style issue keys, e.g. `PROJ-123` (uppercased project + number). */
  jiraKeys: string[]
  /** GitHub issue/PR refs, normalized: `#12` → `12`, `owner/repo#12` kept verbatim. */
  githubRefs: string[]
  /** Absolute http(s) URLs, for matching against an imported item's canonical URL. */
  urls: string[]
}

// A Jira key is an uppercase project key (letter then letters/digits) + `-` + digits.
// Word-bounded so it doesn't catch mid-identifier substrings.
const JIRA_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g
// `owner/repo#123` (cross-repo) OR a bare `#123` not glued to a word char before `#`.
const GITHUB_REF = /(?:\b[\w.-]+\/[\w.-]+)?#\d+\b/g
const URL = /https?:\/\/[^\s)<>"']+/g

/** Dedupe preserving first-seen order. */
function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/** Strip trailing punctuation a URL regex tends to swallow from prose. */
function trimUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, '')
}

/**
 * Pull every explicitly-named reference out of a block of prose. Returns deduped
 * lists; resolution against the imported corpus (which validates them and discards
 * the unresolvable) happens in the engine, not here.
 */
export function extractReferences(text: string): ExtractedReferences {
  if (!text) return { jiraKeys: [], githubRefs: [], urls: [] }
  const jiraKeys = unique(text.match(JIRA_KEY) ?? [])
  const githubRefs = unique((text.match(GITHUB_REF) ?? []).map((ref) => ref.replace(/^#/, '')))
  const urls = unique((text.match(URL) ?? []).map(trimUrl))
  return { jiraKeys, githubRefs, urls }
}
