<script setup lang="ts">
// Hard onboarding gate shown after login when the GitHub integration is enabled
// but the workspace has no App installation yet. cat-factory's whole flow runs on
// the App (agents open PRs on the user's repos), so the board is withheld until
// the App is installed/connected. Reuses <GitHubConnect>, which drives the
// account-level install (https://github.com/apps/<slug>/installations/new — the
// user picks the account/org and grants all or a subset of repos) plus the
// pick-an-existing-installation path. A "Sign out" escape hatch avoids trapping a
// user who needs to switch GitHub accounts.
import GitHubConnect from '~/components/github/GitHubConnect.vue'

const auth = useAuthStore()
</script>

<template>
  <div
    class="flex h-full w-full items-center justify-center overflow-y-auto bg-slate-950 text-slate-100"
  >
    <div
      class="my-8 w-full max-w-md rounded-xl border border-slate-800 bg-slate-900/80 p-8 backdrop-blur"
    >
      <div class="mb-5 text-center">
        <UIcon name="i-lucide-github" class="mx-auto mb-3 h-10 w-10 text-indigo-400" />
        <h1 class="mb-1 text-lg font-semibold text-white">Connect cat-factory to GitHub</h1>
        <p class="text-sm text-slate-400">
          cat-factory works by opening pull requests on your repositories. Install the GitHub App on
          your account or organization to continue — you can grant it every repository or pick a
          subset.
        </p>
      </div>

      <GitHubConnect />

      <p
        v-if="auth.required && auth.user"
        class="mt-6 border-t border-slate-800 pt-4 text-center text-xs text-slate-500"
      >
        Signed in as {{ auth.user.login }} ·
        <button class="text-slate-300 underline-offset-2 hover:underline" @click="auth.logout()">
          Sign out
        </button>
      </p>
    </div>
  </div>
</template>
