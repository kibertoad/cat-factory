<script setup lang="ts">
// The first-run role question: asks once what the person is here to do, so the SPA can open on
// the surfaces that job needs. Offered at launch (at most once per session, and only until it is
// answered: see `stores/uiRole.ts`) and re-openable at any time from the command palette.
//
// It states what each role GIVES you rather than only naming it, because the narrowed role
// genuinely removes destinations: a person picking blind would either avoid the choice or make it
// and not know what happened to their sidebar. Same reason the footer names the way back.
//
// Closing without picking writes nothing: the role stays the default (the FULL surface), and the
// next launch asks again. There is deliberately no "don't ask me again": an unanswered question
// costs nothing here, where a wrongly-recorded answer costs a person destinations they need.
import { ROLE_PRESENTATION, UI_ROLES, type UiRole } from '~/utils/uiRole'

const { t } = useI18n()
const uiRole = useUiRoleStore()

const open = computed({
  get: () => uiRole.promptOpen,
  set: (v: boolean) => (v ? uiRole.openPrompt() : uiRole.closePrompt()),
})

function pick(role: UiRole) {
  uiRole.setRole(role)
}
</script>

<template>
  <UModal v-model:open="open" :title="t('uiRole.prompt.title')" :ui="{ content: 'max-w-lg' }">
    <template #body>
      <div class="space-y-4" data-testid="role-prompt">
        <p class="text-sm text-slate-300">{{ t('uiRole.prompt.intro') }}</p>
        <div class="space-y-2">
          <button
            v-for="role in UI_ROLES"
            :key="role"
            type="button"
            :data-testid="`role-option-${role}`"
            :aria-pressed="role === uiRole.role && uiRole.chosen"
            class="flex w-full items-center gap-3 rounded-lg border p-3 text-start transition"
            :class="
              role === uiRole.role && uiRole.chosen
                ? 'border-indigo-500/60 bg-indigo-500/10'
                : 'border-slate-800 bg-slate-900/60 hover:border-slate-600 hover:bg-slate-800/60'
            "
            @click="pick(role)"
          >
            <UIcon :name="ROLE_PRESENTATION[role].icon" class="h-5 w-5 shrink-0 text-primary-400" />
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-slate-100">
                {{ t(ROLE_PRESENTATION[role].labelKey) }}
              </div>
              <p class="text-xs text-slate-400">{{ t(ROLE_PRESENTATION[role].hintKey) }}</p>
            </div>
          </button>
        </div>
        <!-- The choice is not a commitment, and saying so is what makes the narrowed role
             pickable: it is one dropdown at the top of the sidebar to leave again. -->
        <p class="text-[11px] leading-snug text-slate-500">{{ t('uiRole.prompt.change') }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end">
        <UButton
          color="neutral"
          variant="soft"
          data-testid="role-prompt-close"
          @click="uiRole.closePrompt()"
        >
          {{ uiRole.chosen ? t('common.close') : t('uiRole.prompt.later') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
