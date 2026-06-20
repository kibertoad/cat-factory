import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import type { ToolSet } from 'ai'

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

/**
 * Guidance appended to an inline agent's system prompt ONLY when a web_search tool
 * is actually attached, so the model is never told about a tool it doesn't have.
 * Mirrors the harness's `WEB_TOOLS_GUIDANCE`: search is for facts that genuinely
 * change or that the agent is unsure of, not a reflex.
 */
export const WEB_SEARCH_GUIDANCE = `

## Web search (use sparingly)

You have a \`web_search\` tool. Use it ONLY to verify things that genuinely change or
that you are unsure of — a current library/API signature, a recent breaking change, a
version, or a security advisory — not as a reflex. Prefer first-party documentation,
and cite the source URL when a recommendation rests on what you found. Do not search
for anything already answered by the context you were given.`

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
