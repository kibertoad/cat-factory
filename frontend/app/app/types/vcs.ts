// ---------------------------------------------------------------------------
// Provider-neutral VCS vocabulary. The platform talks to several git providers
// (GitHub, GitLab, …) through one GitHub-shaped service layer, so the SPA's data
// stays neutral and only its PRESENTATION switches on the provider.
//
// All wire shapes come from @cat-factory/contracts (single source of truth).
// ---------------------------------------------------------------------------

import type { VcsProviderWire } from '@cat-factory/contracts'

export type { VcsConnectMethod, VcsConnectOption, VcsProviderWire } from '@cat-factory/contracts'

/** The VCS a connection / repository belongs to — the discriminator presentation keys off. */
export type VcsProvider = VcsProviderWire
