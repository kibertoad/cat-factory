import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createLaunchPrompt } from '~/stores/launchPrompt'
import { isFullSurfaceRole, resolveUiRole, roleSurface, type UiRole } from '~/utils/uiRole'

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
 * `chosen` is the whole of the first-run condition: `storedRole` is `null` until an answer is
 * recorded, which is what the prompt asks about, and it is what a browser that has never been
 * asked and a browser whose answer was cleared have in common. The resolved role stays
 * {@link DEFAULT_UI_ROLE} throughout, so an unanswered question never takes a destination away.
 */
export const useUiRoleStore = defineStore(
  'uiRole',
  () => {
    /** The person's explicit pick, persisted. `null` until they choose one. */
    const storedRole = ref<UiRole | null>(null)

    const role = computed<UiRole>(() => resolveUiRole(storedRole.value))
    const surface = computed(() => roleSurface(role.value))
    /**
     * The role sees the whole product. Read by the nav gate of the same name and by the few
     * surfaces that narrow inline; stated positively so no reader has to invert it.
     */
    const fullSurface = computed(() => isFullSurfaceRole(role.value))
    /** An answer has been recorded, so the first-run prompt has nothing left to ask. */
    const chosen = computed(() => storedRole.value !== null)

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
