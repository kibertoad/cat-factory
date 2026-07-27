import type { VcsProvider } from '~/types/domain'

// ---------------------------------------------------------------------------
// Shared VCS provider presentation. The platform's repo DATA is provider-neutral (one
// GitHub-shaped store serves GitLab through the backend adapter), so only presentation
// switches on the provider — and it switches HERE, once, rather than per component.
//
// Labels are brand names, kept verbatim in every locale, so they are constants rather than
// catalog keys (the same convention the login screen and the API-key provider descriptors
// already use). Anything that is PROSE stays in the i18n catalog, keyed per provider.
//
// Each map is an exhaustive `Record<VcsProvider, …>`: adding a provider to the union fails
// the typecheck here instead of silently rendering a GitHub icon for it.
// ---------------------------------------------------------------------------

/** Brand name, as rendered in titles and buttons. */
export const VCS_PROVIDER_LABELS: Record<VcsProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
}

export const VCS_PROVIDER_ICONS: Record<VcsProvider, string> = {
  github: 'i-lucide-github',
  gitlab: 'i-lucide-gitlab',
}

/** Where a user creates a personal access token for the provider (the PAT connect flow). */
export const VCS_PROVIDER_TOKEN_URLS: Record<VcsProvider, string> = {
  github: 'https://github.com/settings/tokens/new',
  gitlab: 'https://gitlab.com/-/user_settings/personal_access_tokens',
}
