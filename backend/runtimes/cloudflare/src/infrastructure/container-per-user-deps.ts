import type { CoreDependencies } from '@cat-factory/orchestration'
import type { D1Database } from '@cloudflare/workers-types'
import { D1LocalModelEndpointRepository } from './repositories/D1LocalModelEndpointRepository'
import { D1TutorialProgressRepository } from './repositories/D1TutorialProgressRepository'
import { D1UserSettingsRepository } from './repositories/D1UserSettingsRepository'

/**
 * The PER-USER stores: state keyed on a person rather than on a board or an account.
 *
 * A cohesive group, and the reason it is a mixin rather than a few lines in `container.ts` is the
 * file-size ratchet on that module, but the grouping earns its keep on its own terms. Every table
 * is keyed `user_id` and is `selfUser`-scoped on the mothership persistence allow-list (a caller may
 * only ever reach their OWN row). So the next per-user store lands here, beside the ones that
 * already share that shape, instead of in the middle of the workspace-scoped repositories where
 * nothing about it would suggest the different scoping.
 *
 * Unconditional: no store here needs a binding, a key or a flag beyond the main database, so none of
 * their features is ever silently off. Mirrored on the Node facade by the corresponding entries in
 * `container-core-deps.ts`.
 */
export function selectPerUserDeps(db: D1Database): Partial<CoreDependencies> {
  return {
    // The user-tier spend budget (migration 0042).
    userSettingsRepository: new D1UserSettingsRepository({ db }),
    // In-app tutorial progress (migration 0080): which walkthroughs this PERSON has finished and
    // which contextual offers have been spent, so neither is a fact about a browser profile.
    tutorialProgressRepository: new D1TutorialProgressRepository({ db }),
    // The locally-run model endpoints (migration 0002). The one store here whose row holds sealed
    // material, and the engine reads NONE of it: what a dispatch wants is the DECLARED half (does
    // this local model read images), which has no key to unseal, which is why this is wired
    // unconditionally while the credential-side service still needs `ENCRYPTION_KEY`.
    localModelEndpointRepository: new D1LocalModelEndpointRepository({ db }),
  }
}
