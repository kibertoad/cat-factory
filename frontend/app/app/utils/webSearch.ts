import type { WebSearchProvider } from '~/types/execution'

// Web search provider labels. Brand names, kept verbatim in every locale, so they are constants
// rather than catalog keys (the convention `utils/vcs.ts` follows).
export const WEB_SEARCH_PROVIDER_LABEL: Record<WebSearchProvider, string> = {
  brave: 'Brave',
  searxng: 'SearXNG',
}
