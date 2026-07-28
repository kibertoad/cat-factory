<script setup lang="ts">
// Paste a GitHub/GitLab file or directory URL to start a document-fragment link without
// the repo typeahead: the URL is parsed client-side (owner/repo + path + file-vs-dir) and
// the repo resolved through the SHARED available-repos list by its exact slug — the
// backend point-reads an exact `owner/name`, so this never depends on the provider's
// name search (where a pasted URL matches nothing). Emits the resolved repo + location;
// the manager stages a file or opens the tree browser at the directory for bulk picking.
import { parseRepoWebUrl } from '@cat-factory/contracts'
import type { GitHubAvailableRepo } from '~/types/domain'

const emit = defineEmits<{
  resolved: [{ repo: GitHubAvailableRepo; path: string; kind: 'file' | 'dir' }]
}>()

const { t } = useI18n()
const github = useGitHubStore()

const url = ref('')
const resolving = ref(false)
const error = ref<string | null>(null)

async function importUrl() {
  const input = url.value.trim()
  if (!input || resolving.value) return
  const parsed = parseRepoWebUrl(input)
  if (!parsed) {
    error.value = t('fragments.documents.urlImport.invalid')
    return
  }
  resolving.value = true
  error.value = null
  const slug = `${parsed.owner}/${parsed.repo}`
  try {
    // Load into the SHARED picker list (not the side-effect-free search) so the repo
    // select alongside this field can render the resolved selection's label.
    await github.loadAvailableRepos(slug)
    const repo = github.availableRepos.find(
      (r) =>
        r.owner.toLowerCase() === parsed.owner.toLowerCase() &&
        r.name.toLowerCase() === parsed.repo.toLowerCase(),
    )
    if (!repo) {
      error.value = t('fragments.documents.urlImport.notFound', { slug })
      return
    }
    emit('resolved', { repo, path: parsed.path, kind: parsed.kind })
    url.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    resolving.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex gap-2">
      <UInput
        v-model="url"
        icon="i-lucide-link-2"
        :placeholder="t('fragments.documents.urlImport.placeholder')"
        class="flex-1"
        data-testid="fragment-url-import-input"
        @keyup.enter="importUrl"
      />
      <UButton
        size="sm"
        variant="outline"
        icon="i-lucide-folder-search"
        :loading="resolving"
        :disabled="!url.trim()"
        data-testid="fragment-url-import-button"
        @click="importUrl"
      >
        {{ t('fragments.documents.urlImport.action') }}
      </UButton>
    </div>
    <p v-if="error" class="text-xs text-red-400" data-testid="fragment-url-import-error">
      {{ error }}
    </p>
  </div>
</template>
