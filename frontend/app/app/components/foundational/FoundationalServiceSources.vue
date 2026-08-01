<script setup lang="ts">
// Repo sources of foundational-service definitions (backend/docs/adr/0031-foundational-services.md).
// Two link shapes, and the choice is the whole reason this form has a mode switch:
//   - `directory` — every immediate subdirectory of the linked path is a service, identified by
//     its `service.md`, with its contract files beside it. The "we keep our specs in a repo" case.
//   - `files`     — an explicit list of contract files, all describing the ONE service the link
//     names. The "just point at my openapi.yaml" case, where there is no directory convention to
//     adopt — which is why the link itself must supply the identity, and the form demands it.
// Mirrors the skill library's sources UI: with the GitHub App connected the user searches a repo
// and browses to a path; otherwise the manual owner/name fields are the fallback.
import { computed, reactive, ref, watch } from 'vue'
import type {
  FoundationalServiceOwnerKind,
  FoundationalServiceSourceMode,
  GitHubAvailableRepo,
} from '~/types/domain'
import {
  useFoundationalServices,
  useFoundationalServicesStore,
} from '~/stores/foundationalServices'
import GitHubRepoSearchSelect from '~/components/github/GitHubRepoSearchSelect.vue'
import RepoTreeBrowser from '~/components/github/RepoTreeBrowser.vue'

const props = defineProps<{ kind: FoundationalServiceOwnerKind; ownerId: string }>()

const catalog =
  props.kind === 'workspace'
    ? useFoundationalServicesStore()
    : useFoundationalServices(props.kind, props.ownerId)
const github = useGitHubStore()
const toast = useToast()
const { t, d } = useI18n()
const { confirm } = useConfirm()

// The rich GitHub pickers reuse the active board's App installation; without it the form falls
// back to manual text entry.
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
const mode = ref<FoundationalServiceSourceMode>('directory')
const repoId = ref<number | undefined>(undefined)
const repo = ref<GitHubAvailableRepo | undefined>(undefined)
const dirPath = ref<string | undefined>(undefined)
const filePaths = ref<string[]>([])
const gitRef = ref('')
const manual = reactive({ repoOwner: '', repoName: '', dirPath: '', filePaths: '' })
const named = reactive({ serviceId: '', serviceName: '', serviceSummary: '' })
const linking = ref(false)

// A new repo selection clears whatever was browsed against the previous one.
watch(repoId, () => {
  dirPath.value = undefined
  filePaths.value = []
})

const modeItems = computed(() => [
  { value: 'directory' as const, label: t('foundational.sources.mode.directory') },
  { value: 'files' as const, label: t('foundational.sources.mode.files') },
])

const ownerName = computed<{ owner: string; name: string } | null>(() => {
  if (githubReady.value) {
    return repo.value ? { owner: repo.value.owner, name: repo.value.name } : null
  }
  const owner = manual.repoOwner.trim()
  const name = manual.repoName.trim()
  return owner && name ? { owner, name } : null
})

/** The linked files, from the browser cart or the manual newline/comma list. */
const linkedFiles = computed(() =>
  githubReady.value
    ? filePaths.value
    : manual.filePaths
        .split(/[\n,]/)
        .map((p) => p.trim())
        .filter(Boolean),
)

// A `files` source names the service its files describe — the backend refuses the link
// otherwise, so the button is disabled rather than letting the user discover it as a 422.
const valid = computed(() => {
  if (!ownerName.value) return false
  if (mode.value !== 'files') return true
  return Boolean(named.serviceId.trim() && named.serviceName.trim() && linkedFiles.value.length)
})

function resetDraft() {
  repoId.value = undefined
  repo.value = undefined
  dirPath.value = undefined
  filePaths.value = []
  gitRef.value = ''
  Object.assign(manual, { repoOwner: '', repoName: '', dirPath: '', filePaths: '' })
  Object.assign(named, { serviceId: '', serviceName: '', serviceSummary: '' })
}

function toggleFile(path: string) {
  filePaths.value = filePaths.value.includes(path)
    ? filePaths.value.filter((p) => p !== path)
    : [...filePaths.value, path]
}

async function link() {
  const target = ownerName.value
  if (!target || !valid.value) return
  linking.value = true
  try {
    const result = await catalog.linkSource({
      repoOwner: target.owner,
      repoName: target.name,
      gitRef: gitRef.value.trim() || undefined,
      mode: mode.value,
      dirPath: (githubReady.value ? dirPath.value : manual.dirPath.trim()) || undefined,
      ...(mode.value === 'files'
        ? {
            filePaths: linkedFiles.value,
            serviceId: named.serviceId.trim(),
            serviceName: named.serviceName.trim(),
            serviceSummary: named.serviceSummary.trim() || undefined,
          }
        : {}),
    })
    resetDraft()
    toast.add({ title: t('foundational.toast.sourceLinked'), icon: 'i-lucide-git-branch' })
    return result
  } catch (e) {
    notifyError(t('foundational.toast.linkSourceFailed'), e)
  } finally {
    linking.value = false
  }
}

async function sync(id: string) {
  await withRow(`sync:${id}`, async () => {
    try {
      const result = await catalog.syncSource(id)
      toast.add({
        title: t('foundational.toast.synced', {
          updated: result.upserted,
          removed: result.tombstoned,
        }),
        icon: 'i-lucide-refresh-cw',
        color: 'info',
      })
    } catch (e) {
      notifyError(t('foundational.toast.syncFailed'), e)
    }
  })
}

async function check(id: string) {
  await withRow(`check:${id}`, async () => {
    try {
      const status = await catalog.checkSource(id)
      toast.add({
        title: status.changed
          ? t('foundational.toast.changesAvailable')
          : t('foundational.toast.upToDate'),
        icon: status.changed ? 'i-lucide-bell-dot' : 'i-lucide-check',
      })
    } catch (e) {
      notifyError(t('foundational.toast.checkSourceFailed'), e)
    }
  })
}

async function unlink(id: string) {
  const source = catalog.sources.find((s) => s.id === id)
  const ok = await confirm({
    title: t('foundational.confirmUnlinkSource.title'),
    description: t('foundational.confirmUnlinkSource.body', {
      repo: source ? `${source.repoOwner}/${source.repoName}` : '',
    }),
    variant: 'destructive',
    confirmLabel: t('foundational.confirmUnlinkSource.confirm'),
    icon: 'i-lucide-unplug',
  })
  if (!ok) return
  await withRow(`unlink:${id}`, async () => {
    try {
      await catalog.unlinkSource(id)
      toast.add({ title: t('foundational.toast.sourceUnlinked'), icon: 'i-lucide-unplug' })
    } catch (e) {
      notifyError(t('foundational.toast.unlinkSourceFailed'), e)
    }
  })
}
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="foundational-sources">
    <div
      v-for="s in catalog.sources"
      :key="s.id"
      class="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 p-3"
    >
      <UIcon name="i-lucide-git-branch" class="h-4 w-4 shrink-0 text-slate-400" />
      <div class="min-w-0">
        <span class="font-mono text-sm text-slate-100">
          {{ s.repoOwner }}/{{ s.repoName }}<span class="text-slate-500">/{{ s.dirPath }}</span>
        </span>
        <p class="text-xs text-slate-500">
          {{
            s.mode === 'files'
              ? t('foundational.sources.metaFiles', {
                  service: s.serviceName ?? s.serviceId ?? '',
                  count: s.filePaths.length,
                })
              : t('foundational.sources.metaDirectory')
          }}
        </p>
        <p class="text-xs text-slate-500">
          {{
            s.lastSyncedAt
              ? t('foundational.sources.metaSynced', {
                  ref: s.gitRef,
                  date: d(new Date(s.lastSyncedAt), 'short'),
                })
              : t('foundational.sources.metaNever', { ref: s.gitRef })
          }}
        </p>
      </div>
      <UBadge
        v-if="catalog.sourceChanges[s.id]"
        size="xs"
        color="warning"
        variant="subtle"
        class="ms-auto"
      >
        {{ t('foundational.sources.changes') }}
      </UBadge>
      <div class="ms-auto flex gap-1">
        <UButton
          icon="i-lucide-search-check"
          size="xs"
          variant="ghost"
          :loading="rowBusy(`check:${s.id}`)"
          :title="t('foundational.sources.check')"
          @click="check(s.id)"
        />
        <UButton
          icon="i-lucide-refresh-cw"
          size="xs"
          variant="ghost"
          :loading="rowBusy(`sync:${s.id}`)"
          :title="t('foundational.sources.sync')"
          @click="sync(s.id)"
        />
        <UButton
          icon="i-lucide-unplug"
          size="xs"
          color="error"
          variant="ghost"
          :loading="rowBusy(`unlink:${s.id}`)"
          :title="t('foundational.sources.unlink')"
          @click="unlink(s.id)"
        />
      </div>
    </div>
    <p v-if="!catalog.sources.length" class="text-sm text-slate-500">
      {{ t('foundational.sources.empty') }}
    </p>

    <!-- Linking needs the GitHub integration; say so rather than offering a form that 503s. -->
    <div
      v-if="!catalog.sourcesAvailable"
      class="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-500"
    >
      {{ t('foundational.sources.githubRequired') }}
    </div>
    <div v-else class="rounded-md border border-slate-800 p-3">
      <p class="mb-2 text-sm font-medium">{{ t('foundational.sources.linkTitle') }}</p>
      <div class="flex flex-col gap-2">
        <URadioGroup v-model="mode" :items="modeItems" orientation="horizontal" size="sm" />
        <p class="text-xs text-slate-500">
          {{
            mode === 'files'
              ? t('foundational.sources.mode.filesHint')
              : t('foundational.sources.mode.directoryHint')
          }}
        </p>

        <!-- Connected: search a repo, then browse to the folder / pick the contract files -->
        <template v-if="githubReady">
          <GitHubRepoSearchSelect v-model="repoId" @update:repo="repo = $event" />
          <div
            v-if="repoId !== undefined"
            class="rounded-md border border-slate-800 bg-slate-900/40 p-2"
          >
            <RepoTreeBrowser
              v-if="mode === 'files'"
              :repo-github-id="repoId"
              mode="file"
              multiple
              :selected-paths="filePaths"
              @toggle="toggleFile"
            />
            <RepoTreeBrowser v-else v-model="dirPath" :repo-github-id="repoId" mode="dir" />
            <p class="mt-2 truncate text-xs text-slate-400">
              <template v-if="mode === 'files'">
                {{ t('foundational.sources.selectedFiles', { count: filePaths.length }) }}
              </template>
              <template v-else-if="dirPath">
                {{ t('foundational.sources.selectedDir') }}
                <code class="text-slate-200">{{ dirPath }}</code>
              </template>
              <template v-else>{{ t('foundational.sources.wholeRepo') }}</template>
            </p>
          </div>
        </template>

        <!-- Not connected to the App: manual owner/name + path fallback -->
        <template v-else>
          <div class="flex gap-2">
            <UInput
              v-model="manual.repoOwner"
              :placeholder="t('foundational.sources.ownerPlaceholder')"
              class="flex-1"
            />
            <UInput
              v-model="manual.repoName"
              :placeholder="t('foundational.sources.repoPlaceholder')"
              class="flex-1"
            />
          </div>
          <UTextarea
            v-if="mode === 'files'"
            v-model="manual.filePaths"
            :rows="3"
            :placeholder="t('foundational.sources.filePathsPlaceholder')"
          />
          <UInput
            v-else
            v-model="manual.dirPath"
            :placeholder="t('foundational.sources.dirPlaceholder')"
          />
        </template>

        <!-- `files` mode carries no directory convention to read identity from, so the link
             supplies it. -->
        <template v-if="mode === 'files'">
          <div class="flex gap-2">
            <UInput
              v-model="named.serviceId"
              :placeholder="t('foundational.sources.serviceIdPlaceholder')"
              class="flex-1"
            />
            <UInput
              v-model="named.serviceName"
              :placeholder="t('foundational.sources.serviceNamePlaceholder')"
              class="flex-1"
            />
          </div>
          <UInput
            v-model="named.serviceSummary"
            :placeholder="t('foundational.sources.serviceSummaryPlaceholder')"
          />
        </template>

        <UInput v-model="gitRef" :placeholder="t('foundational.sources.refPlaceholder')" />
        <UButton
          icon="i-lucide-link"
          size="sm"
          :disabled="!valid"
          :loading="linking"
          class="self-start"
          data-testid="foundational-link-source"
          @click="link"
        >
          {{ t('foundational.sources.link') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
