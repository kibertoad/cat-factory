<script setup lang="ts">
// Pick a linked repository and one of its pull requests (an open one from the synced list, or any
// number typed in) to open a guided review on.
import type { OpenGuidedReviewInput } from '~/types/domain'

defineProps<{ opening: boolean }>()
const emit = defineEmits<{ open: [target: OpenGuidedReviewInput] }>()
const { t } = useI18n()
const github = useGitHubStore()

const repoId = ref<number | undefined>(undefined)
const prNumber = ref<number | undefined>(undefined)

const repoItems = computed(() =>
  github.repos.map((r) => ({ label: `${r.owner}/${r.name}`, value: r.githubId })),
)
const repo = computed(() => github.repos.find((r) => r.githubId === repoId.value))
const openPulls = computed(() =>
  repo.value ? github.pullsForRepo(repo.value.githubId).filter((p) => p.state === 'open') : [],
)

function submit(number = prNumber.value): void {
  const r = repo.value
  if (!r || !number) return
  emit('open', {
    owner: r.owner,
    repo: r.name,
    prNumber: number,
    ...(r.provider ? { provider: r.provider } : {}),
  })
}
</script>

<template>
  <div class="mx-auto max-w-xl space-y-4" data-testid="guided-review-picker">
    <p class="text-sm text-muted">{{ t('guidedReview.picker.intro') }}</p>
    <p v-if="!github.repos.length" class="text-sm text-toned">
      {{ t('guidedReview.picker.noRepos') }}
    </p>
    <template v-else>
      <UFormField :label="t('guidedReview.picker.repo')">
        <USelectMenu
          v-model="repoId"
          :items="repoItems"
          value-key="value"
          class="w-full"
          data-testid="guided-review-picker-repo"
        />
      </UFormField>
      <div v-if="openPulls.length" class="space-y-1">
        <p class="text-xs font-semibold uppercase text-dimmed">
          {{ t('guidedReview.picker.openPulls') }}
        </p>
        <UButton
          v-for="pr in openPulls"
          :key="pr.number"
          block
          size="sm"
          variant="ghost"
          color="neutral"
          class="justify-start"
          :disabled="opening"
          :data-testid="`guided-review-picker-pr-${pr.number}`"
          @click="submit(pr.number)"
        >
          <span class="truncate">#{{ pr.number }} {{ pr.title }}</span>
        </UButton>
      </div>
      <div class="flex items-end gap-2">
        <UFormField :label="t('guidedReview.picker.number')" class="flex-1">
          <UInputNumber
            v-model="prNumber"
            :min="1"
            class="w-full"
            data-testid="guided-review-picker-number"
          />
        </UFormField>
        <UButton
          color="primary"
          icon="i-lucide-scan-search"
          :loading="opening"
          :disabled="!repo || !prNumber"
          data-testid="guided-review-picker-open"
          @click="submit()"
        >
          {{ t('guidedReview.picker.open') }}
        </UButton>
      </div>
    </template>
  </div>
</template>
