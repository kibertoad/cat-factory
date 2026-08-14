import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createLaunchPrompt } from '~/stores/launchPrompt'
import {
  isFullSurfaceRole,
  parseUiRole,
  resolveUiRole,
  roleSurface,
  type UiRole,
} from '~/utils/uiRole'

/**
 * The role the person is here to do (`engineer` / `product-manager` / `designer`) and the
 * first-run question that asks for it. Resolution and the surface each role maps to are in
 * `utils/uiRole.ts`.
 *
 * Only the person's own choice exists: there is deliberately NO deployment env pin, unlike the
 * interface tier. The tier is a fleet-shaped decision an operator can reasonably make for a
 * kiosk deployment; which JOB the person at the keyboard does is not something the build can
 * know, and pinning it would leave a designer's laptop configured as an engineer's with no way
 * to say otherwise.
 *
 * `chosen` is the whole of the first-run condition: no recognised answer is recorded, which is
 * what the prompt asks about, and it is what a browser that has never been asked, one whose
 * answer was cleared, and one carrying a value that is no longer a role all have in common. The
 * resolved role stays the default throughout, so an unanswered question never takes a
 * destination away.
 */
export const useUiRoleStore = defineStore(
  'uiRole',
  () => {
    /** The person's explicit pick, persisted. `null` until they choose one. */
    const storedRole = ref<UiRole | null>(null)

    /**
     * The persisted pick, COERCED, and the only thing anything below reads.
     *
     * `storedRole`'s type describes what {@link setRole} WRITES, not what boot restores into it:
     * the persistence plugin rehydrates a JSON blob a previous build wrote or a person hand-
     * edited, so an unknown string arrives typed as a `UiRole` and every reader believes it.
     * There is nothing forgiving downstream to catch it: `ROLE_SURFACES[role]` is `undefined`,
     * which narrows the nav to intake without a word, and `ROLE_PRESENTATION[role].labelKey`
     * throws in the switcher, i.e. white-screens the board rather than degrading. So the raw
     * value is parsed ONCE here, exactly as `agentTier` does with its own restored level.
     *
     * `chosen` reads it too, and that is the half that makes the degradation honest rather than
     * merely safe: an unrecognised value is not an answer, so the first-run prompt asks again
     * and the person can replace it. Reading `storedRole !== null` instead would leave a browser
     * pinned to the default with the question it needs to be asked already marked settled.
     */
    const pickedRole = computed<UiRole | null>(() => parseUiRole(storedRole.value))

    const role = computed<UiRole>(() => resolveUiRole(pickedRole.value))
    const surface = computed(() => roleSurface(role.value))
    /**
     * The role sees the whole product. Read by the nav gate of the same name and by the few
     * surfaces that narrow inline; stated positively so no reader has to invert it.
     */
    const fullSurface = computed(() => isFullSurfaceRole(role.value))
    /** A RECOGNISED answer has been recorded, so the first-run prompt has nothing left to ask. */
    const chosen = computed(() => pickedRole.value !== null)

    // The same once-per-session launch machine the tutorial offer runs on: the question is
    // answered by PICKING a role, so `hasDecision` is exactly `chosen`. Closing without picking
    // writes nothing and the next launch asks again, which is safe here precisely because the
    // default is the full surface.
    const prompt = createLaunchPrompt({ hasDecision: () => chosen.value })

    /** Record the person's pick and settle the question. */
    function setRole(next: UiRole) {
      storedRole.value = next
      prompt.promptOpen.value = false
    }

    return {
      role,
      surface,
      fullSurface,
      chosen,
      storedRole,
      ...prompt,
      setRole,
    }
  },
  { persist: { pick: ['storedRole'] } },
)
