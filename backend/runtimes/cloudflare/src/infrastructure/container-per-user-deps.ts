import type { CoreDependencies } from '@cat-factory/orchestration'
import type { D1Database } from '@cloudflare/workers-types'
import { D1TutorialProgressRepository } from './repositories/D1TutorialProgressRepository'
import { D1UserSettingsRepository } from './repositories/D1UserSettingsRepository'

/**
 * The PER-USER stores: state keyed on a person rather than on a board or an account.
 *
 * A cohesive group, and the reason it is a mixin rather than four lines in `container.ts` is the
 * file-size ratchet on that module — but the grouping earns its keep on its own terms. Both tables
 * are keyed `user_id`, neither holds secret material, and both are `selfUser`-scoped on the
 * mothership persistence allow-list (a caller may only ever reach their OWN row). So the next
 * per-user store lands here, beside the two that already share that shape, instead of in the middle
 * of the workspace-scoped repositories where nothing about it would suggest the different scoping.
 *
 * Unconditional: neither store needs a binding, a key or a flag beyond the main database, so both
 * are always wired and their features are never silently off. Mirrored on the Node facade by the
 * corresponding entries in `container-core-deps.ts`.
 */
export function selectPerUserDeps(db: D1Database): Partial<CoreDependencies> {
  return {
    // The user-tier spend budget (migration 0042).
    userSettingsRepository: new D1UserSettingsRepository({ db }),
    // In-app tutorial progress (migration 0080): which walkthroughs this PERSON has finished and
    // which contextual offers have been spent, so neither is a fact about a browser profile.
    tutorialProgressRepository: new D1TutorialProgressRepository({ db }),
  }
}
