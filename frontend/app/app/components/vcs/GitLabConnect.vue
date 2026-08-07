<script setup lang="ts">
// Per-workspace GitLab connect surface — the PAT analogue of <GitHubConnect>. GitLab has no
// App-installation concept, so there is nothing to discover and nothing to redirect to: the
// user pastes a personal access token, the backend validates it upstream, seals it, and writes
// the same projection rows the GitHub connect writes (stamped `provider: 'gitlab'`). Once
// connected, every repo surface downstream is the shared GitHub-shaped one.
//
// The token never persists in the browser: it lives in the field for the length of the request
// and is cleared on success. A rejected token comes back as a typed API error whose message
// says why (invalid, revoked, or missing the `api` scope), so it is shown inline rather than
// flattened into a generic toast.
import SecretInput from '~/components/common/SecretInput.vue'
import { apiErrorEnvelope } from '~/composables/api/errors'
import { vcsTokenCreateUrl } from '~/utils/vcs'

const { t } = useI18n()
const github = useGitHubStore()
const toast = useToast()

const pat = ref('')
const connecting = ref(false)
const error = ref<string | null>(null)

// The token page on the instance this deployment would connect, not on gitlab.com: a
// self-managed GitLab's tokens are minted on its own host. The advertised host is null when the
// deployment's API base does not name one, and only THIS link falls back to the public instance
// (a wrong settings page costs a click; see `~/utils/vcs`).
const tokenUrl = computed(() =>
  vcsTokenCreateUrl('gitlab', github.connectOptions.find((o) => o.provider === 'gitlab')?.webUrl),
)

async function connect() {
  const token = pat.value.trim()
  if (!token || connecting.value) return
  connecting.value = true
  error.value = null
  try {
    await github.connectGitLab(token)
    pat.value = ''
    toast.add({
      title: t('vcs.connect.gitlab.toast.connected'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    error.value =
      apiErrorEnvelope(e)?.message ??
      (e instanceof Error ? e.message : t('vcs.connect.gitlab.errors.connect'))
  } finally {
    connecting.value = false
  }
}
</script>

<template>
  <section class="space-y-3">
    <p class="text-sm text-slate-400">{{ t('vcs.connect.gitlab.intro') }}</p>

    <UFormField :label="t('vcs.connect.gitlab.tokenLabel')" :hint="t('vcs.connect.gitlab.scope')">
      <SecretInput
        v-model="pat"
        placeholder="glpat-…"
        autocomplete="off"
        class="w-full"
        data-testid="gitlab-pat-input"
        @keyup.enter="connect"
      />
    </UFormField>

    <p class="text-[11px] text-slate-500">
      <ULink :to="tokenUrl" target="_blank" class="text-indigo-400 hover:underline">
        {{ t('vcs.connect.gitlab.createToken') }}
      </ULink>
    </p>

    <p v-if="error" class="text-sm text-rose-400" data-testid="gitlab-connect-error">
      {{ error }}
    </p>

    <UButton
      color="primary"
      icon="i-lucide-gitlab"
      :loading="connecting"
      :disabled="!pat.trim()"
      data-testid="gitlab-connect-submit"
      @click="connect"
    >
      {{ t('vcs.connect.gitlab.submit') }}
    </UButton>
  </section>
</template>
