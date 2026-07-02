<script setup lang="ts">
// A reusable server-side GitHub repository picker: the same searchable combobox the
// add-service modal uses, extracted so any window that needs to pick a repo the App
// can access gets identical behaviour (type ≥ MIN_SEARCH_LEN chars → the backend
// filters `owner/name`, nothing is prefetched). Exposes the selected repo's numeric
// id via `v-model`, and emits the full `GitHubAvailableRepo` (owner/name/flags) via
// `update:repo` for callers that need more than the id.
import { refDebounced } from '@vueuse/core'
import type { GitHubAvailableRepo } from '~/types/domain'

const props = defineProps<{
  /** Selected repo GitHub numeric id, via v-model. */
  modelValue?: number
}>()
const emit = defineEmits<{
  'update:modelValue': [number | undefined]
  'update:repo': [GitHubAvailableRepo | undefined]
}>()

const { t } = useI18n()
const github = useGitHubStore()

// A wide App install (or a PAT) can expose hundreds of repos — too many to prefetch and
// filter client-side — so the picker searches SERVER-SIDE once the user types at least
// MIN_SEARCH_LEN characters (debounced). Below the gate the list stays empty.
const MIN_SEARCH_LEN = 3
const repoSearch = ref('')
const repoSearchDebounced = refDebounced(repoSearch, 250)
const repoQueryRaw = computed(() => repoSearchDebounced.value.trim())
const belowMinChars = computed(() => repoQueryRaw.value.length < MIN_SEARCH_LEN)

// The picked repo, captured when selected — the loaded list is volatile (a later search
// replaces it), so the selection can't be derived from `availableRepos` after the fact.
const selectedRepo = ref<GitHubAvailableRepo | undefined>(undefined)

function toRepoItem(r: GitHubAvailableRepo) {
  const suffix = r.private ? t('github.addService.repoLabel.private') : ''
  return { label: `${r.owner}/${r.name}${suffix}`, value: r.githubId }
}

const repoItems = computed(() => github.availableRepos.map(toRepoItem))
const queryMatches = computed(() => (belowMinChars.value ? [] : repoItems.value))

// Items fed to the combobox: the matches plus the current selection kept present, so the
// menu still renders the selected repo's label after a later search replaces the list.
const repoMenuItems = computed(() => {
  const matches = queryMatches.value
  if (props.modelValue === undefined) return matches
  if (matches.some((r) => r.value === props.modelValue)) return matches
  return selectedRepo.value ? [toRepoItem(selectedRepo.value), ...matches] : matches
})

// Fetch matches server-side as the debounced query changes; below the gate clear the list.
watch(repoQueryRaw, (q) => {
  void github.loadAvailableRepos(q.length >= MIN_SEARCH_LEN ? q : '')
})

const selectedId = computed({
  get: () => props.modelValue,
  set: (v: number | undefined) => emit('update:modelValue', v),
})

// On selection, capture the picked repo (from the still-current loaded list) and surface it.
watch(
  () => props.modelValue,
  (id) => {
    if (id === undefined) {
      selectedRepo.value = undefined
      emit('update:repo', undefined)
      return
    }
    const found = github.availableRepos.find((r) => r.githubId === id)
    if (found) {
      selectedRepo.value = found
      emit('update:repo', found)
    }
  },
)

function clear() {
  emit('update:modelValue', undefined)
  emit('update:repo', undefined)
  repoSearch.value = ''
}
</script>

<template>
  <UInputMenu
    v-model="selectedId"
    v-model:search-term="repoSearch"
    :items="repoMenuItems"
    :ignore-filter="true"
    value-key="value"
    :loading="github.loadingAvailable"
    icon="i-lucide-search"
    :placeholder="t('github.addService.searchPlaceholder')"
    class="w-full"
  >
    <template v-if="selectedId !== undefined" #trailing>
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        icon="i-lucide-x"
        :aria-label="t('github.addService.clearSelection')"
        @click.stop="clear"
      />
    </template>
    <template #empty>
      <span v-if="belowMinChars">
        {{ t('github.addService.searchMinChars', { min: MIN_SEARCH_LEN }, MIN_SEARCH_LEN) }}
      </span>
      <span v-else-if="!github.loadingAvailable">
        {{ t('github.addService.noMatches', { query: repoQueryRaw }) }}
      </span>
    </template>
  </UInputMenu>
</template>
