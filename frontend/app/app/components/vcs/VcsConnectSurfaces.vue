<script setup lang="ts">
// The connect surfaces a deployment can actually serve, in one place. A deployment wires a
// GitHub App, a per-workspace GitLab PAT connect, both, or neither, and only
// `GET /vcs/connect-options` (via the store's `canConnect*`) can say which — a connection
// READ says nothing, because the `github` module builds for either provider.
//
// Every surface that can strand a user on "not connected yet" renders this: the source-control
// panel, the onboarding gate, and the two modals that need a connection before they can do
// anything (add-service-from-repo, bootstrap). They had diverged — both modals hardcoded the
// GitHub App picker, so a GitLab-only deployment offered an installation flow it cannot serve
// and no way to connect at all — which is why the fan-out lives here rather than being copied
// a fourth time.
//
// Explicit imports: the auto-import name for `github/GitHubConnect` doesn't match the
// `<GitHubConnect>` tag (see GitHubPanel), so both children are bound by path.
import GitHubConnect from '~/components/github/GitHubConnect.vue'
import GitLabConnect from '~/components/vcs/GitLabConnect.vue'

const props = defineProps<{
  /**
   * Copy shown above the GitHub App picker only, since it is the one surface whose flow needs
   * explaining (pick an account, grant repo access). Omitted ⇒ no intro, which is what the
   * modals want: their own prompt already said why a connection is needed.
   */
  appIntro?: string
}>()

const { t } = useI18n()
const github = useGitHubStore()

// Whether the deployment serves neither surface. Rendered as a statement rather than an empty
// box: "nothing is configured" and "we couldn't read what is configured" both land here, and a
// blank space would read as the connect UI still loading.
const nothingConfigured = computed(() => !github.canConnectGitHubApp && !github.canConnectGitLabPat)
</script>

<template>
  <div class="space-y-3">
    <template v-if="github.canConnectGitHubApp">
      <p v-if="props.appIntro" class="text-sm text-slate-400">{{ props.appIntro }}</p>
      <GitHubConnect />
    </template>

    <USeparator
      v-if="github.canConnectGitHubApp && github.canConnectGitLabPat"
      :label="t('vcs.connect.or')"
    />

    <GitLabConnect v-if="github.canConnectGitLabPat" />

    <p
      v-if="nothingConfigured"
      class="rounded-md border border-dashed border-slate-800 px-3 py-3 text-sm text-slate-400"
    >
      {{ t('vcs.connect.noneConfigured') }}
    </p>
  </div>
</template>
