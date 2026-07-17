<script setup lang="ts">
// Repo-sourced Claude Skills library manager (docs/initiatives/repo-skills.md), for the account
// tier (skills are a single tier — shared across the account's workspaces). Link repo directories
// of `<skill>/SKILL.md` folders, resync them (with a "changes available" badge), and review the
// synced skill catalog a pipeline `skill` step picks from. Mirrors the fragment library's
// repo-sources UI; when the GitHub App is connected the user searches a repo + browses to the
// skills directory, otherwise the manual owner/name/dir fields are the fallback.
import { computed, reactive, ref, watch } from 'vue'
import type { GitHubAvailableRepo } from '~/types/domain'
import { useSkillLibrary } from '~/stores/skillLibrary'
import GitHubRepoSearchSelect from '~/components/github/GitHubRepoSearchSelect.vue'
import RepoTreeBrowser from '~/components/github/RepoTreeBrowser.vue'

const props = defineProps<{ accountId: string }>()

const library = useSkillLibrary(props.accountId)
const github = useGitHubStore()
const toast = useToast()
const { t, d } = useI18n()
const { confirm } = useConfirm()

watch(
  () => props.accountId,
  () => {
    void library.probe()
    // The GitHub pickers need the active board's installation state; probe once so they light up.
    void github.probe()
  },
  { immediate: true },
)

// The rich GitHub pickers reuse the active board's App installation. When it isn't connected (or
// the integration is off) the form falls back to manual text entry.
const githubReady = computed(() => github.available === true && github.connected)

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

// Per-row in-flight tracking so only the control that triggered an action spins.
const busyRows = reactive(new Set<string>())
const rowBusy = (key: string) => busyRows.has(key)
async function withRow(key: string, fn: () => Promise<void>) {
  if (busyRows.has(key)) return
  busyRows.add(key)
  try {
    await fn()
  } finally {
    busyRows.delete(key)
  }
}

// ---- link a repo source ----------------------------------------------------
const sourceRepoId = ref<number | undefined>(undefined)
const sourceRepo = ref<GitHubAvailableRepo | undefined>(undefined)
const sourceDir = ref<string | undefined>(undefined)
const sourceRef = ref('')
const manualSource = ref({ repoOwner: '', repoName: '', dirPath: '' })
const linkingSource = ref(false)

// A new repo selection clears the previously-browsed directory.
watch(sourceRepoId, () => {
  sourceDir.value = undefined
})

const sourceOwnerName = computed<{ owner: string; name: string } | null>(() => {
  if (githubReady.value) {
    return sourceRepo.value ? { owner: sourceRepo.value.owner, name: sourceRepo.value.name } : null
  }
  const owner = manualSource.value.repoOwner.trim()
  const name = manualSource.value.repoName.trim()
  return owner && name ? { owner, name } : null
})
const sourceValid = computed(() => sourceOwnerName.value !== null)

function resetSourceDraft() {
  sourceRepoId.value = undefined
  sourceRepo.value = undefined
  sourceDir.value = undefined
  sourceRef.value = ''
  manualSource.value = { repoOwner: '', repoName: '', dirPath: '' }
}

async function linkSource() {
  const ownerName = sourceOwnerName.value
  if (!ownerName) return
  const dirPath =
    (githubReady.value ? sourceDir.value : manualSource.value.dirPath.trim()) || undefined
  linkingSource.value = true
  try {
    await library.linkSource({
      repoOwner: ownerName.owner,
      repoName: ownerName.name,
      dirPath,
      gitRef: sourceRef.value.trim() || undefined,
    })
    resetSourceDraft()
    toast.add({ title: t('skills.toast.sourceLinked'), icon: 'i-lucide-git-branch' })
  } catch (e) {
    notifyError(t('skills.toast.linkSourceFailed'), e)
  } finally {
    linkingSource.value = false
  }
}

async function syncSource(id: string) {
  await withRow(`sync:${id}`, async () => {
    try {
      const result = await library.syncSource(id)
      toast.add({
        title: t('skills.toast.synced', {
          updated: result.upserted,
          removed: result.tombstoned,
        }),
        icon: 'i-lucide-refresh-cw',
        color: 'info',
      })
    } catch (e) {
      notifyError(t('skills.toast.syncFailed'), e)
    }
  })
}

async function checkSource(id: string) {
  await withRow(`check:${id}`, async () => {
    try {
      const status = await library.checkSource(id)
      toast.add({
        title: status.changed ? t('skills.toast.changesAvailable') : t('skills.toast.upToDate'),
        icon: status.changed ? 'i-lucide-bell-dot' : 'i-lucide-check',
      })
    } catch (e) {
      notifyError(t('skills.toast.checkSourceFailed'), e)
    }
  })
}

async function unlinkSource(id: string) {
  const source = library.sources.find((s) => s.id === id)
  const repo = source ? `${source.repoOwner}/${source.repoName}` : ''
  const ok = await confirm({
    title: t('skills.confirmUnlinkSource.title'),
    description: t('skills.confirmUnlinkSource.body', { repo }),
    variant: 'destructive',
    confirmLabel: t('skills.confirmUnlinkSource.confirm'),
    icon: 'i-lucide-unplug',
  })
  if (!ok) return
  await withRow(`unlink:${id}`, async () => {
    try {
      await library.unlinkSource(id)
      toast.add({ title: t('skills.toast.sourceUnlinked'), icon: 'i-lucide-unplug' })
    } catch (e) {
      notifyError(t('skills.toast.unlinkSourceFailed'), e)
    }
  })
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- The library is opt-in; if a deployment disabled it, don't offer forms that would fail
         with a raw 503 — say so instead. -->
    <div
      v-if="library.available === false"
      class="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-400"
    >
      {{ t('skills.unavailable') }}
    </div>

    <template v-else>
      <!-- Synced skill catalog -->
      <div class="flex flex-col gap-2">
        <p class="text-sm font-medium">{{ t('skills.catalog.title') }}</p>
        <div
          v-for="s in library.catalog"
          :key="s.id"
          class="flex items-start gap-2 rounded-md border border-slate-800 bg-slate-900/60 p-3"
        >
          <UIcon name="i-lucide-book-open-check" class="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-slate-100">{{ s.name }}</p>
            <p class="text-xs text-slate-400">{{ s.description }}</p>
            <p class="mt-1 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
              <span v-if="s.resources.length">
                {{ t('skills.catalog.resources', { count: s.resources.length }) }}
              </span>
              <span v-if="s.pinnedCommit" class="font-mono">
                {{ t('skills.catalog.pinned', { commit: s.pinnedCommit.slice(0, 7) }) }}
              </span>
            </p>
          </div>
        </div>
        <p v-if="!library.catalog.length" class="text-sm text-slate-500">
          {{ t('skills.catalog.empty') }}
        </p>
      </div>

      <!-- Repo sources -->
      <div class="flex flex-col gap-3">
        <p class="text-sm font-medium">{{ t('skills.sources.title') }}</p>
        <div
          v-for="s in library.sources"
          :key="s.id"
          class="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 p-3"
        >
          <UIcon name="i-lucide-git-branch" class="h-4 w-4 text-slate-400" />
          <div class="min-w-0">
            <span class="font-mono text-sm text-slate-100">
              {{ s.repoOwner }}/{{ s.repoName
              }}<span class="text-slate-500">/{{ s.dirPath || '' }}</span>
            </span>
            <p class="text-xs text-slate-500">
              {{
                s.lastSyncedAt
                  ? t('skills.sources.metaSynced', {
                      ref: s.gitRef,
                      date: d(new Date(s.lastSyncedAt), 'short'),
                    })
                  : t('skills.sources.metaNever', { ref: s.gitRef })
              }}
            </p>
          </div>
          <UBadge
            v-if="library.sourceChanges[s.id]"
            size="xs"
            color="warning"
            variant="subtle"
            class="ms-auto"
          >
            {{ t('skills.sources.changes') }}
          </UBadge>
          <div class="ms-auto flex gap-1">
            <UButton
              icon="i-lucide-search-check"
              size="xs"
              variant="ghost"
              :loading="rowBusy(`check:${s.id}`)"
              :title="t('skills.sources.check')"
              @click="checkSource(s.id)"
            />
            <UButton
              icon="i-lucide-refresh-cw"
              size="xs"
              variant="ghost"
              :loading="rowBusy(`sync:${s.id}`)"
              :title="t('skills.sources.sync')"
              @click="syncSource(s.id)"
            />
            <UButton
              icon="i-lucide-unplug"
              size="xs"
              color="error"
              variant="ghost"
              :loading="rowBusy(`unlink:${s.id}`)"
              :title="t('skills.sources.unlink')"
              @click="unlinkSource(s.id)"
            />
          </div>
        </div>
        <p v-if="!library.sources.length" class="text-sm text-slate-500">
          {{ t('skills.sources.empty') }}
        </p>

        <!-- Link a new source. Needs the GitHub integration; hide the form when it's off. -->
        <div
          v-if="!library.sourcesAvailable"
          class="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-500"
        >
          {{ t('skills.sources.githubRequired') }}
        </div>
        <div v-else class="rounded-md border border-slate-800 p-3">
          <p class="mb-2 text-sm font-medium">{{ t('skills.sources.linkTitle') }}</p>
          <div class="flex flex-col gap-2">
            <!-- Connected: search a repo + browse to the skills directory -->
            <template v-if="githubReady">
              <GitHubRepoSearchSelect v-model="sourceRepoId" @update:repo="sourceRepo = $event" />
              <div
                v-if="sourceRepoId !== undefined"
                class="rounded-md border border-slate-800 bg-slate-900/40 p-2"
              >
                <p class="mb-2 text-xs text-slate-400">
                  {{ t('skills.sources.browseHint') }}
                </p>
                <RepoTreeBrowser v-model="sourceDir" :repo-github-id="sourceRepoId" mode="dir" />
                <p class="mt-2 truncate text-xs text-slate-400">
                  <template v-if="sourceDir">
                    {{ t('skills.sources.selectedDir') }}
                    <code class="text-slate-200">{{ sourceDir }}</code>
                  </template>
                  <template v-else>{{ t('skills.sources.wholeRepo') }}</template>
                </p>
              </div>
            </template>

            <!-- Not connected to the App: manual owner/name/dir fallback -->
            <template v-else>
              <div class="flex gap-2">
                <UInput
                  v-model="manualSource.repoOwner"
                  :placeholder="t('skills.sources.ownerPlaceholder')"
                  class="flex-1"
                />
                <UInput
                  v-model="manualSource.repoName"
                  :placeholder="t('skills.sources.repoPlaceholder')"
                  class="flex-1"
                />
              </div>
              <UInput
                v-model="manualSource.dirPath"
                :placeholder="t('skills.sources.dirPlaceholder')"
              />
            </template>

            <UInput v-model="sourceRef" :placeholder="t('skills.sources.refPlaceholder')" />
            <UButton
              icon="i-lucide-link"
              size="sm"
              :disabled="!sourceValid"
              :loading="linkingSource"
              class="self-start"
              @click="linkSource"
            >
              {{ t('skills.sources.link') }}
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
