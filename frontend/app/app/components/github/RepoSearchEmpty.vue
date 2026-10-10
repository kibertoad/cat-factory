<script setup lang="ts">
// The empty-state body shared by the GitHub repo pickers (the add-service modal and the doc-task
// reference-repo picker), both driven by `useRepoSearch`: below the min-length gate it prompts for
// more characters; otherwise (once a search has settled) it reports no matches. Kept as one
// component so the two pickers can't drift on the empty-state copy or behaviour.
import { REPO_SEARCH_MIN_LEN } from '~/composables/useRepoSearch'

defineProps<{ belowMinChars: boolean; loading: boolean; query: string }>()

const { t } = useI18n()
</script>

<template>
  <span v-if="belowMinChars">
    {{ t('github.addService.searchMinChars', { min: REPO_SEARCH_MIN_LEN }, REPO_SEARCH_MIN_LEN) }}
  </span>
  <span v-else-if="!loading">{{ t('github.addService.noMatches', { query }) }}</span>
</template>
