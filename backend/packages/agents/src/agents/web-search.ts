import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import type { ToolSet } from 'ai'
import { registeredWebResearchHint } from './registry.js'

// Provider-hosted web search for the INLINE agents (architect / researcher), which
// run a single `generateText` call via the AI SDK rather than going through the Pi
// container harness. Anthropic and OpenAI expose a server-executed web_search tool
// the SDK runs inline (the provider performs the search and folds the results into
// the same response — no client-side tool loop), exactly how Claude Code and Codex
// add web access. Providers without a hosted search (workers-ai, the
// OpenAI-compatible trio, mock) get no tool, so those deployments run unchanged.

/** Default inline kinds allowed to search the web — the design/research steps. */
export const DEFAULT_INLINE_WEB_SEARCH_KINDS: ReadonlySet<string> = new Set([
  'architect',
  'researcher',
])

/** Default ceiling on provider web searches per inline run (Anthropic `maxUses`). */
export const DEFAULT_INLINE_WEB_SEARCH_MAX_USES = 5

/** How inline web search is configured for a deployment (off unless built). */
export interface InlineWebSearchOptions {
  /** Agent kinds permitted to use provider web search. */
  kinds: ReadonlySet<string>
  /** Max provider web searches per run (Anthropic `maxUses`; OpenAI manages its own). */
  maxUses: number
}

// Per-kind reason an agent reaches for web search, so the nudge speaks to what that
// agent is actually doing rather than a generic "verify facts". These are the defaults
// for the BUILT-IN kinds; a custom/proprietary kind supplies its own via the registry
// (`AgentKindDefinition.webResearchHint`), which wins — so the shared composition here
// never needs to know a proprietary kind exists. Resolution order is registry → these
// built-in defaults → GENERIC_WEB_RESEARCH_HINT (see `webResearchGuidanceFor`).
const BUILTIN_WEB_RESEARCH_HINTS: Record<string, string> = {
  coder:
    'confirm a current library/API signature before you rely on it, and check for a known breaking change when an import or call behaves unexpectedly',
  'ci-fixer':
    "search the exact failing error message, or a dependency's changelog/known issues, to find the real fix instead of guessing at versions",
  mocker:
    "fetch the real third-party API's reference (endpoints, status codes, payload shapes, error formats) so the stubs match production behaviour",
  analysis:
    'check whether a dependency is deprecated, end-of-life, or has a known CVE / newer major version when judging technical debt',
  'business-documenter':
    'verify domain or regulatory terminology when documenting business rules, so the captured rules use the correct, current vocabulary',
  playwright:
    "confirm a current testing-framework or locator API when the project's version differs from what you remember",
  architect:
    'compare current library/framework options and their trade-offs, and verify a capability or version is real before you design around it',
  researcher:
    'this is your primary tool — survey prior art, candidate libraries, benchmarks and known pitfalls, and ground every recommendation in a cited source',
}

const GENERIC_WEB_RESEARCH_HINT =
  "verify a fact that genuinely changes — a library version, an API, a recent breaking change, a security advisory — when the repository itself can't answer it"

/**
 * The web-search guidance appended to an agent's context ONLY when the tools are
 * actually available, so the model is never told about a tool it lacks. The hint is
 * tailored to `kind`; `fetch` controls whether the companion `web_fetch` tool (the Pi
 * container path has it; the inline provider tool does not) is mentioned. Mirrors the
 * harness's own conservative framing: search is for things that change or that the
 * agent is unsure of, not a reflex, and never a substitute for reading the code.
 */
export function webResearchGuidanceFor(kind: string, opts: { fetch?: boolean } = {}): string {
  // A proprietary/custom kind's own hint wins (it knows its job; the shared library
  // doesn't); then the built-in defaults; then the generic fallback.
  const hint =
    registeredWebResearchHint(kind) ?? BUILTIN_WEB_RESEARCH_HINTS[kind] ?? GENERIC_WEB_RESEARCH_HINT
  const tools = opts.fetch
    ? '`web_search` (titled result snippets for a query) and `web_fetch` (read a URL as text)'
    : 'a `web_search` tool'
  const them = opts.fetch ? 'them' : 'it'
  return `

## Web search (use sparingly)

You have ${tools}. Use ${them} mainly to ${hint}. Prefer first-party documentation, and
cite the source URL when a decision rests on what you find. Do not search for anything
already in the checkout or the context you were given, and don't let searching replace
reading the code.`
}

/**
 * The provider-hosted web_search tool set for a provider, or undefined when the
 * provider has no server-executed web search the AI SDK can run inline. Only the
 * provider id is consulted — the actual search runs under the model request's own
 * credentials, so this just selects the right provider-defined tool spec.
 */
export function providerWebSearchTools(
  provider: string,
  maxUses: number = DEFAULT_INLINE_WEB_SEARCH_MAX_USES,
): ToolSet | undefined {
  if (provider === 'anthropic') {
    return { web_search: anthropic.tools.webSearch_20250305({ maxUses }) }
  }
  if (provider === 'openai') {
    // OpenAI's hosted search runs via the Responses API; `@ai-sdk/openai`'s default
    // model uses it, so a standard `openai:gpt-…` model resolves correctly. The
    // per-run cap isn't a tool parameter here (OpenAI manages its own budget), so
    // `maxUses` only applies to the Anthropic tool above.
    return { web_search: openai.tools.webSearch({}) }
  }
  return undefined
}

/**
 * Read inline web-search configuration from a deployment's environment, or
 * undefined when it is not enabled. `INLINE_WEB_SEARCH_ENABLED` (truthy) is the
 * single opt-in switch; `INLINE_WEB_SEARCH_KINDS` (comma-separated) overrides the
 * default architect/researcher allow-list, and `INLINE_WEB_SEARCH_MAX_USES` caps
 * searches per run. Off ⇒ the inline agents run exactly as before.
 */
export function inlineWebSearchOptionsFromEnv(env: {
  INLINE_WEB_SEARCH_ENABLED?: string
  INLINE_WEB_SEARCH_KINDS?: string
  INLINE_WEB_SEARCH_MAX_USES?: string
}): InlineWebSearchOptions | undefined {
  const enabled = env.INLINE_WEB_SEARCH_ENABLED?.trim().toLowerCase()
  if (enabled !== 'true' && enabled !== '1' && enabled !== 'yes') return undefined
  const kindList = (env.INLINE_WEB_SEARCH_KINDS ?? '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
  const maxUses = Number(env.INLINE_WEB_SEARCH_MAX_USES)
  return {
    kinds: kindList.length ? new Set(kindList) : DEFAULT_INLINE_WEB_SEARCH_KINDS,
    maxUses:
      Number.isFinite(maxUses) && maxUses > 0
        ? Math.floor(maxUses)
        : DEFAULT_INLINE_WEB_SEARCH_MAX_USES,
  }
}
