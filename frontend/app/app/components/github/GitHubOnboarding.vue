<script setup lang="ts">
// Hard onboarding gate shown after login when the VCS integration is enabled but the workspace
// has no connection yet. cat-factory's whole flow runs on a connected repository host (agents
// open pull/merge requests on the user's repos), so the board is withheld until the workspace
// connects one. <VcsConnectSurfaces> renders whichever connect methods the deployment serves; a
// "Sign out" escape hatch avoids trapping a user who needs to switch accounts.
import VcsConnectSurfaces from '~/components/vcs/VcsConnectSurfaces.vue'
import { VCS_PROVIDER_ICONS, VCS_PROVIDER_LABELS } from '~/utils/vcs'

const { t } = useI18n()
const auth = useAuthStore()
const github = useGitHubStore()

// A deployment that serves exactly one provider names it; one serving several stays neutral
// (the per-surface copy below then says which is which).
const sole = computed(() => github.soleConnectProvider)
const icon = computed(() => (sole.value ? VCS_PROVIDER_ICONS[sole.value] : 'i-lucide-git-branch'))
const title = computed(() =>
  sole.value
    ? t('vcs.onboarding.title', { provider: VCS_PROVIDER_LABELS[sole.value] })
    : t('vcs.onboarding.titleAny'),
)
</script>

<template>
  <div
    class="flex h-full w-full items-center justify-center overflow-y-auto bg-slate-950 text-slate-100"
  >
    <div
      class="my-8 w-full max-w-md rounded-xl border border-slate-800 bg-slate-900/80 p-8 backdrop-blur"
    >
      <div class="mb-5 text-center">
        <UIcon :name="icon" class="mx-auto mb-3 h-10 w-10 text-indigo-400" />
        <h1 class="mb-1 text-lg font-semibold text-white">{{ title }}</h1>
        <p class="text-sm text-slate-400">
          {{ t('vcs.onboarding.intro') }}
        </p>
      </div>

      <VcsConnectSurfaces :app-intro="t('github.onboarding.appIntro')" />

      <p
        v-if="auth.required && auth.user"
        class="mt-6 border-t border-slate-800 pt-4 text-center text-xs text-slate-500"
      >
        {{ t('github.onboarding.signedInAs', { login: auth.user.login }) }} ·
        <button class="text-slate-300 underline-offset-2 hover:underline" @click="auth.logout()">
          {{ t('github.onboarding.signOut') }}
        </button>
      </p>
    </div>
  </div>
</template>
