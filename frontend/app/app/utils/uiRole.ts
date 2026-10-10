/**
 * The ROLE the person at the keyboard is here to do: `engineer`, `product-manager` or
 * `designer`. Pure resolution logic, kept out of the store so it is testable without Pinia.
 *
 * This is the third narrowing axis in the SPA and it answers a different question from the
 * other two. The interface MODE (`utils/uiMode.ts`) asks how much of the product to show;
 * the AGENT TIER asks how deep into the agent catalog one surface reaches; the role asks
 * WHICH JOB the surfaces are for. Engineer and product-manager do the same job here (plan
 * work, run it, review and merge it), so they resolve to the same surface today and are kept
 * as separate members because the copy people pick themselves by is the thing that makes the
 * question answerable, and because the two diverge the moment one of them gets a surface the
 * other does not.
 *
 * It is NOT authorization. Workspace RBAC (ADR 0025) decides what a request may do, is
 * enforced server-side, and cannot be widened from a browser; this decides what the SPA
 * OFFERS, and every role resolves to a surface the caller's permissions still gate. A role
 * that hid a permitted destination would be a lie about the product, which is why the way
 * back out of a narrowed role is reachable from inside it (see `UiRoleSwitcher`).
 */
export const UI_ROLES = ['engineer', 'product-manager', 'designer'] as const

export type UiRole = (typeof UI_ROLES)[number]

/**
 * The role a browser gets before the person picks one.
 *
 * The FULL surface, deliberately: an unanswered question must never take capability away.
 * The first-run prompt is offered once per session until it is answered (see `stores/uiRole.ts`),
 * and closing it leaves the whole product in place rather than guessing a narrower persona.
 */
const DEFAULT_UI_ROLE: UiRole = 'engineer'

/**
 * How much of the SPA a role is offered.
 *
 * - `full`: every destination the caller's permissions and the interface tier allow.
 * - `intake`: the services already on the board, the tasks in flight on them, and the routes
 *   that bring new work IN (a new task, a task from a tracker ticket, a task from a design).
 *   None of the platform configuration behind them: an intake role never sets up a repo, a
 *   model, a pipeline or an integration, so carrying those destinations costs the surface more
 *   than the capability is worth there.
 *
 * A SURFACE rather than a per-role list of ids, because the narrowing is a property of the
 * WORK, not of the persona's name: a second delivery-only persona reuses `intake` instead of
 * copying its allow-list, and nothing has to be re-decided per role. The mapping is an
 * exhaustive Record, so a new role fails the build until it picks a side.
 */
export type RoleSurface = 'full' | 'intake'

export const ROLE_SURFACES: Record<UiRole, RoleSurface> = {
  engineer: 'full',
  'product-manager': 'full',
  designer: 'intake',
}

/**
 * How each role is PRESENTED: its name, the one line that says what picking it gives you, and
 * its glyph. One table rather than a copy in the switcher and another in the first-run prompt,
 * because the two surfaces must not be able to describe the same role differently. The prompt
 * is where the choice is explained and the switcher is where it is recognised later.
 *
 * i18n keys rather than strings (no display copy in code), and an exhaustive Record, so a new
 * role fails the build until it has both. The keys themselves are invisible to typed messages
 * and to `i18n:check`, since neither sees a key reached through a table lookup rather than
 * written literally at the call site, which is what `uiRole.spec.ts` asserts against the base
 * catalog instead.
 */
export interface RolePresentation {
  labelKey: string
  hintKey: string
  icon: string
}

export const ROLE_PRESENTATION: Record<UiRole, RolePresentation> = {
  engineer: {
    labelKey: 'uiRole.roles.engineer',
    hintKey: 'uiRole.hints.engineer',
    icon: 'i-lucide-code-xml',
  },
  'product-manager': {
    labelKey: 'uiRole.roles.productManager',
    hintKey: 'uiRole.hints.productManager',
    icon: 'i-lucide-clipboard-list',
  },
  designer: {
    labelKey: 'uiRole.roles.designer',
    hintKey: 'uiRole.hints.designer',
    icon: 'i-lucide-frame',
  },
}

/**
 * Coerce an untrusted value (a restored localStorage blob, possibly written by an older
 * build or hand-edited) to a known role. Anything unrecognised resolves to `null`, i.e.
 * "nobody has picked one", so {@link resolveUiRole} falls back to the default and the
 * first-run prompt asks again. Never throws: a stale persisted value must not fail the boot.
 */
export function parseUiRole(raw: unknown): UiRole | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  return (UI_ROLES as readonly string[]).includes(value) ? (value as UiRole) : null
}

/** Apply the precedence: the person's own stored choice → {@link DEFAULT_UI_ROLE}. */
export function resolveUiRole(stored: UiRole | null): UiRole {
  return stored ?? DEFAULT_UI_ROLE
}

/** Which surface a role is offered. */
export function roleSurface(role: UiRole): RoleSurface {
  return ROLE_SURFACES[role]
}

/**
 * Whether the role sees the whole product.
 *
 * Stated POSITIVELY, and read that way everywhere (the `fullSurface` nav gate, the
 * `intake` contribution flag it admits): a narrowing expressed as "not hidden" inverts once
 * per reader and the reader that gets it backwards shows a designer the operator dashboard.
 */
export function isFullSurfaceRole(role: UiRole): boolean {
  return roleSurface(role) === 'full'
}
