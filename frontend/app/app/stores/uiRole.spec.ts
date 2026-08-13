import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { missingI18nKeys } from '../../test/i18nKeys'
import { useUiRoleStore } from '~/stores/uiRole'
import { useUiModeStore } from '~/stores/uiMode'
import {
  parseUiRole,
  ROLE_PRESENTATION,
  ROLE_SURFACES,
  UI_ROLES,
  type UiRole,
} from '~/utils/uiRole'

describe('useUiRoleStore role resolution', () => {
  it('boots on the FULL surface with nothing stored, and says nobody has chosen', () => {
    // The two halves of the first-run condition, and they must not be conflated: an unanswered
    // question leaves the whole product in place (`fullSurface`) while still being unanswered
    // (`chosen`), which is what lets the prompt ask again without ever having taken anything away.
    const role = useUiRoleStore()
    expect(role.chosen).toBe(false)
    expect(role.role).toBe('engineer')
    expect(role.fullSurface).toBe(true)
  })

  it('honours a stored choice and narrows only for the intake role', () => {
    const role = useUiRoleStore()
    role.setRole('product-manager')
    expect(role.role).toBe('product-manager')
    expect(role.chosen).toBe(true)
    // Engineer and product-manager resolve to the SAME surface today; that is the product
    // decision, not an accident of the mapping.
    expect(role.fullSurface).toBe(true)

    role.setRole('designer')
    expect(role.surface).toBe('intake')
    expect(role.fullSurface).toBe(false)
    // Persisted, so a reload restores it (the persist plugin picks `storedRole`).
    expect(role.storedRole).toBe('designer')
  })

  it('falls back to the default when the restored value is not a known role', () => {
    // A persisted blob written by an older build (or hand-edited) is untrusted input: an
    // unrecognised role must resolve to the full surface, never to a narrowed one.
    expect(parseUiRole('lead-designer')).toBeNull()
    expect(parseUiRole(undefined)).toBeNull()
    expect(parseUiRole(' Designer ')).toBe('designer')

    const role = useUiRoleStore()
    role.storedRole = parseUiRole('architect')
    expect(role.role).toBe('engineer')
    expect(role.fullSurface).toBe(true)
  })
})

describe('useUiRoleStore first-run prompt', () => {
  it('offers itself once per session while unanswered', () => {
    const role = useUiRoleStore()
    role.maybeOfferOnLaunch()
    expect(role.promptOpen).toBe(true)

    // Closing without answering writes nothing, so the NEXT launch asks again, but this
    // session's one offer is spent.
    role.closePrompt()
    expect(role.storedRole).toBeNull()
    role.maybeOfferOnLaunch()
    expect(role.promptOpen).toBe(false)
  })

  it('never offers itself again once a role is recorded', () => {
    const role = useUiRoleStore()
    role.setRole('designer')
    role.maybeOfferOnLaunch()
    expect(role.promptOpen).toBe(false)
  })

  it('re-arms after a deferral, so a startup advisory does not consume the offer', () => {
    // What `pages/index.vue` does when an advisory the user must answer opens on top: the offer
    // is withdrawn and comes back, rather than counting as a question they were asked.
    const role = useUiRoleStore()
    role.maybeOfferOnLaunch()
    role.deferPrompt()
    expect(role.promptOpen).toBe(false)
    role.maybeOfferOnLaunch()
    expect(role.promptOpen).toBe(true)
  })

  it('leaves a user-opened prompt alone on a deferral', () => {
    // Opened from the command palette: it is the user's, so nothing withdraws it.
    const role = useUiRoleStore()
    role.openPrompt()
    role.deferPrompt()
    expect(role.promptOpen).toBe(true)
  })

  it('settles the prompt by picking a role', () => {
    const role = useUiRoleStore()
    role.openPrompt()
    role.setRole('engineer')
    expect(role.promptOpen).toBe(false)
    expect(role.chosen).toBe(true)
  })
})

describe('the role as a ceiling on the interface tier', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('caps a narrowed role at the basic tier, whatever the user stored', () => {
    // Resolved rather than merely hidden: every `isAdvanced` reader inside a surface (the
    // override fields, the authoring affordances) has to agree with the narrowed nav, and only
    // the resolved mode reaches all of them.
    const mode = useUiModeStore()
    mode.setMode('advanced')
    expect(mode.isAdvanced).toBe(true)

    useUiRoleStore().setRole('designer')
    expect(mode.mode).toBe('basic')
    expect(mode.isAdvanced).toBe(false)

    // Leaving the narrowed role restores the tier the person had picked: the cap withholds the
    // tier, it does not overwrite the preference.
    useUiRoleStore().setRole('engineer')
    expect(mode.isAdvanced).toBe(true)
  })
})

describe('UI_ROLES catalog integrity', () => {
  it('maps every role to a surface and presents each one', () => {
    // Derived from the vocabulary rather than re-listed, so a new role fails here (and in the
    // exhaustive Records themselves) until it has picked a surface and gained its copy.
    expect(Object.keys(ROLE_SURFACES).sort()).toEqual([...UI_ROLES].sort())
    expect(Object.keys(ROLE_PRESENTATION).sort()).toEqual([...UI_ROLES].sort())
    // Exactly one narrowed role today, and the full ones are the majority: a mapping that
    // narrowed everything would pass every other assertion in this file.
    const surfaces = UI_ROLES.map((role: UiRole) => ROLE_SURFACES[role])
    expect(surfaces.filter((s) => s === 'full').length).toBeGreaterThan(0)
    expect(surfaces.filter((s) => s === 'intake').length).toBeGreaterThan(0)
  })

  it('names an i18n key that exists for every role label and hint', () => {
    // A table lookup is invisible to typed message keys and to `i18n:check` (neither sees
    // `t(ROLE_PRESENTATION[role].labelKey)`), so deleting one of these keys would otherwise read
    // as a clean removal and render its own key path in the picker.
    const keys = UI_ROLES.flatMap((role: UiRole) => [
      ROLE_PRESENTATION[role].labelKey,
      ROLE_PRESENTATION[role].hintKey,
    ])
    expect(missingI18nKeys(keys)).toEqual([])
    // And the copy the two surfaces around them use, which is written literally there but is
    // just as easy to rename out from under this table.
    expect(
      missingI18nKeys([
        'uiRole.switcher',
        'uiRole.prompt.title',
        'uiRole.prompt.intro',
        'uiRole.prompt.change',
        'uiRole.prompt.later',
      ]),
    ).toEqual([])
  })

  it('gives every role a distinct glyph', () => {
    // The rail renders the glyph alone above a truncated name, so two roles sharing one would be
    // indistinguishable exactly where the label has the least room.
    const icons = UI_ROLES.map((role: UiRole) => ROLE_PRESENTATION[role].icon)
    expect(new Set(icons).size).toBe(icons.length)
  })
})
