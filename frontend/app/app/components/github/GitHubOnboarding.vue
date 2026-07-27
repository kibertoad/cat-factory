<script setup lang="ts">
// Hard onboarding gate shown after login when the VCS integration is enabled but the workspace
// has no connection yet. cat-factory's whole flow runs on a connected repository host (agents
// open pull/merge requests on the user's repos), so the board is withheld until the workspace
// connects one. Renders the connect surfaces the deployment can actually serve: <GitHubConnect>
// drives the account-level App install (https://github.com/apps/<slug>/installations/new — the
// user picks the account/org and grants all or a subset of repos) plus the
// pick-an-existing-installation path, and <GitLabConnect> takes a pasted GitLab PAT. A "Sign
// out" escape hatch avoids trapping a user who needs to switch accounts.
import GitHubConnect from '~/components/github/GitHubConnect.vue'
import GitLabConnect from '~/components/vcs/GitLabConnect.vue'
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

      <template v-if="github.canConnectGitHubApp">
        <p class="mb-3 text-sm text-slate-400">{{ t('github.onboarding.appIntro') }}</p>
        <GitHubConnect />
      </template>
      <USeparator
        v-if="github.canConnectGitHubApp && github.canConnectGitLabPat"
        class="my-4"
        :label="t('vcs.connect.or')"
      />
      <GitLabConnect v-if="github.canConnectGitLabPat" />
      <p
        v-if="!github.canConnectGitHubApp && !github.canConnectGitLabPat"
        class="rounded-md border border-dashed border-slate-800 px-3 py-3 text-sm text-slate-400"
      >
        {{ t('vcs.connect.noneConfigured') }}
      </p>

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
