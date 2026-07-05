<script setup lang="ts">
// Reference repositories for a document-authoring task. The doc-writer agent clones each attached
// repo READ-ONLY as a sibling checkout it may read (to reuse existing solutions as a reference)
// while drafting — it never writes to them. Any repo the workspace's GitHub App (or the signed-in
// user's PAT) can reach may be attached, so this reuses the SAME server-side, debounced repo
// search as the add-service picker (`useRepoSearch`), not a filter over the synced projection.
import type { Block, GitHubAvailableRepo, ReferenceRepo } from '~/types/domain'

const props = defineProps<{ block: Block }>()

const { t } = useI18n()
const github = useGitHubStore()
const board = useBoardStore()

const {
  search: repoSearch,
  query: repoQuery,
  belowMinChars,
  results: repoResults,
  loading: repoLoading,
  reset: resetRepoSearch,
} = useRepoSearch()

const attached = computed<ReferenceRepo[]>(() => props.block.referenceRepos ?? [])
const attachedIds = computed(() => new Set(attached.value.map((r) => r.githubId)))

// Menu items: the searched repos, an already-attached one disabled so it can't be added twice.
const repoItems = computed(() =>
  belowMinChars.value
    ? []
    : repoResults.value.map((r) => ({
        label: `${r.owner}/${r.name}${r.personal ? t('github.addService.repoLabel.personal') : ''}`,
        value: r.githubId,
        disabled: attachedIds.value.has(r.githubId),
      })),
)

// The picked repo id; watched to attach then clear (the combobox has no "add" affordance of its
// own, so selecting a repo IS the attach action).
const pickedId = ref<number | undefined>(undefined)

watch(pickedId, (id) => {
  if (id === undefined) return
  const repo = repoResults.value.find((r) => r.githubId === id)
  pickedId.value = undefined
  if (!repo || attachedIds.value.has(id)) return
  attach(repo)
})

function toReference(repo: GitHubAvailableRepo): ReferenceRepo {
  return {
    githubId: repo.githubId,
    owner: repo.owner,
    name: repo.name,
    // A repo with no reported default branch is rare; fall back to `main` so the clone has a ref.
    defaultBranch: repo.defaultBranch ?? 'main',
    // A repo the App reaches carries the workspace installation; a PAT-only (`personal`) repo has
    // none, so the run clones it with the initiator's token instead.
    ...(repo.personal || !github.connection
      ? {}
      : { installationId: github.connection.installationId }),
  }
}

function attach(repo: GitHubAvailableRepo) {
  board.updateBlock(props.block.id, {
    referenceRepos: [...attached.value, toReference(repo)],
  })
  resetRepoSearch()
}

function detach(githubId: number) {
  board.updateBlock(props.block.id, {
    referenceRepos: attached.value.filter((r) => r.githubId !== githubId),
  })
}
</script>

<template>
  <div data-testid="doc-reference-repos">
    <div class="mb-1 flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('inspector.referenceRepos.title') }}
      </span>
    </div>

    <!-- Attached reference repos: chips with a remove control. -->
    <div v-if="attached.length" class="mb-1.5 flex flex-wrap gap-1">
      <UBadge
        v-for="r in attached"
        :key="r.githubId"
        size="sm"
        variant="soft"
        color="neutral"
        data-testid="reference-repo-chip"
      >
        {{ r.owner }}/{{ r.name }}
        <UButton
          color="neutral"
          variant="link"
          size="xs"
          icon="i-lucide-x"
          :aria-label="t('inspector.referenceRepos.remove', { repo: `${r.owner}/${r.name}` })"
          data-testid="reference-repo-remove"
          @click="detach(r.githubId)"
        />
      </UBadge>
    </div>

    <!-- The picker: only usable once the workspace's GitHub App is connected. -->
    <UInputMenu
      v-if="github.connected"
      v-model="pickedId"
      v-model:search-term="repoSearch"
      :items="repoItems"
      :ignore-filter="true"
      value-key="value"
      :loading="repoLoading"
      icon="i-lucide-search"
      :placeholder="t('github.addService.searchPlaceholder')"
      class="w-full"
      data-testid="reference-repo-search"
    >
      <template #empty>
        <span v-if="belowMinChars">
          {{
            t('github.addService.searchMinChars', { min: REPO_SEARCH_MIN_LEN }, REPO_SEARCH_MIN_LEN)
          }}
        </span>
        <span v-else-if="!repoLoading">{{
          t('github.addService.noMatches', { query: repoQuery })
        }}</span>
      </template>
    </UInputMenu>
    <div v-else class="text-[11px] text-slate-500">
      {{ t('inspector.referenceRepos.connectFirst') }}
    </div>

    <div class="mt-1 text-[11px] text-slate-500">
      {{ t('inspector.referenceRepos.hint') }}
    </div>
  </div>
</template>
