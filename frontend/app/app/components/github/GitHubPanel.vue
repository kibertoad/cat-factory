<script setup lang="ts">
// GitHub integration panel: connect the workspace's App installation, manage the
// connection (disconnect / resync), and browse the projected repos, branches,
// pull requests and issues the backend caches in D1. Mirrors the document-source
// connect/import surface, but for GitHub. Writes (new branch, open/merge PR,
// comment) go straight to the repo via the backend's installation token.
import type { GitHubPullRequest, GitHubRepo } from '~/types/domain'
// Explicit import: the auto-import name for a component nested under a
// like-named directory (github/GitHubConnect) doesn't match the `<GitHubConnect>`
// tag, so it silently renders as an empty element. Importing it directly binds
// the tag unambiguously.
import GitHubConnect from './GitHubConnect.vue'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const ui = useUiStore()
const github = useGitHubStore()
const toast = useToast()

const open = computed({
  get: () => ui.githubOpen,
  set: (v: boolean) => {
    if (!v) ui.closeGitHub()
  },
})

// On open: refresh projections when connected. The not-connected state renders
// <GitHubConnect>, which discovers and links installations on its own.
watch(open, (isOpen) => {
  if (!isOpen) return
  if (github.connected) void github.load()
})

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

async function disconnect() {
  try {
    await github.disconnect()
    toast.add({ title: 'GitHub disconnected', icon: 'i-lucide-unplug' })
  } catch (e) {
    notifyError('Could not disconnect', e)
  }
}

async function resync(full = false) {
  try {
    const { status } = await github.resync({ full })
    toast.add({ title: `Resync ${status}`, icon: 'i-lucide-refresh-cw', color: 'info' })
  } catch (e) {
    notifyError('Could not resync', e)
  }
}

// ---- browse ----------------------------------------------------------------
type Tab = 'repos' | 'pulls' | 'issues'
const tab = ref<Tab>('repos')
const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'repos', label: 'Repositories', icon: 'i-lucide-folder-git-2' },
  { id: 'pulls', label: 'Pull requests', icon: 'i-lucide-git-pull-request' },
  { id: 'issues', label: 'Issues', icon: 'i-lucide-circle-dot' },
]

// Manage which repos this board links (the installation is shared across the
// account; each board picks its own repos).
const managing = ref(false)
const selected = ref<Set<number>>(new Set())

async function openManage() {
  managing.value = true
  try {
    await github.loadAvailableRepos()
    selected.value = new Set(github.availableRepos.filter((r) => r.linked).map((r) => r.githubId))
  } catch (e) {
    notifyError('Could not load repositories', e)
    managing.value = false
  }
}

function toggleSelected(githubId: number) {
  const next = new Set(selected.value)
  if (next.has(githubId)) next.delete(githubId)
  else next.add(githubId)
  selected.value = next
}

async function saveRepos() {
  try {
    await github.setLinkedRepos([...selected.value])
    managing.value = false
    toast.add({ title: 'Linked repositories updated', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError('Could not update repositories', e)
  }
}

// Repos: expand to load branches + open an inline "new branch" form.
const expandedRepo = ref<number | null>(null)
const branchForm = ref<{ name: string; fromSha: string }>({ name: '', fromSha: '' })
const creatingBranch = ref(false)

async function toggleRepo(repo: GitHubRepo) {
  if (expandedRepo.value === repo.githubId) {
    expandedRepo.value = null
    return
  }
  expandedRepo.value = repo.githubId
  branchForm.value = { name: '', fromSha: '' }
  if (!github.branches[repo.githubId]) {
    try {
      await github.loadBranches(repo.githubId)
    } catch (e) {
      notifyError('Could not load branches', e)
    }
  }
}

async function createBranch(repo: GitHubRepo) {
  const name = branchForm.value.name.trim()
  const fromSha = branchForm.value.fromSha.trim()
  if (!name || !fromSha) return
  creatingBranch.value = true
  try {
    await github.createBranch(repo.githubId, { name, fromSha })
    branchForm.value = { name: '', fromSha: '' }
    toast.add({ title: `Branch ${name} created`, icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError('Could not create branch', e)
  } finally {
    creatingBranch.value = false
  }
}

// Pull requests: open a new PR + merge an existing open one.
const prForm = ref<{ repoGithubId: number | null; title: string; head: string; base: string }>({
  repoGithubId: null,
  title: '',
  head: '',
  base: '',
})
const showPrForm = ref(false)
const openingPr = ref(false)

const repoMenu = computed(() => [
  github.repos.map((r) => ({
    label: `${r.owner}/${r.name}`,
    icon: 'i-lucide-folder-git-2',
    onSelect: () => {
      prForm.value.repoGithubId = r.githubId
      if (!prForm.value.base) prForm.value.base = r.defaultBranch ?? ''
    },
  })),
])
const prRepo = computed(() => github.repos.find((r) => r.githubId === prForm.value.repoGithubId))
const canOpenPr = computed(
  () =>
    !!prForm.value.repoGithubId &&
    prForm.value.title.trim() &&
    prForm.value.head.trim() &&
    prForm.value.base.trim(),
)

async function openPr() {
  if (!canOpenPr.value) return
  openingPr.value = true
  try {
    await github.openPullRequest(prForm.value.repoGithubId!, {
      title: prForm.value.title.trim(),
      head: prForm.value.head.trim(),
      base: prForm.value.base.trim(),
    })
    showPrForm.value = false
    prForm.value = { repoGithubId: null, title: '', head: '', base: '' }
    toast.add({ title: 'Pull request opened', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError('Could not open pull request', e)
  } finally {
    openingPr.value = false
  }
}

const merging = ref<number | null>(null)
async function merge(pr: GitHubPullRequest) {
  merging.value = pr.number
  try {
    await github.mergePullRequest(pr.repoGithubId, pr.number, { method: 'squash' })
    toast.add({ title: `PR #${pr.number} merged`, icon: 'i-lucide-git-merge', color: 'success' })
  } catch (e) {
    notifyError('Could not merge', e)
  } finally {
    merging.value = null
  }
}
</script>

<template>
  <UModal v-model:open="open" title="GitHub" :ui="{ content: 'max-w-2xl' }">
    <template #title>
      <IntegrationBackTitle title="GitHub" @back="((open = false), ui.openIntegrations())" />
    </template>
    <template #body>
      <div class="space-y-5">
        <!-- not connected: connect -->
        <template v-if="!github.connected">
          <p class="text-sm text-slate-400">
            Connect a GitHub App installation to back board blocks with repositories, browse pull
            requests and issues, and let agents push branches and open PRs.
          </p>

          <GitHubConnect />
        </template>

        <!-- connected: manage + browse -->
        <template v-else>
          <!-- connection header -->
          <div
            class="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2"
          >
            <div class="flex items-center gap-2 min-w-0">
              <UIcon name="i-lucide-github" class="h-5 w-5 text-slate-300" />
              <div class="min-w-0">
                <div class="truncate text-sm text-slate-200">
                  {{ github.connection?.accountLogin }}
                </div>
                <div class="text-[11px] text-slate-500">
                  {{ github.connection?.targetType }} · installation
                  {{ github.connection?.installationId }}
                </div>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-refresh-cw"
                :loading="github.syncing"
                @click="resync(false)"
              >
                Resync
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-history"
                :disabled="github.syncing"
                @click="resync(true)"
              >
                Backfill
              </UButton>
              <UButton
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-unplug"
                @click="disconnect"
              />
            </div>
          </div>

          <!-- tabs -->
          <div class="flex gap-1">
            <UButton
              v-for="t in tabs"
              :key="t.id"
              size="sm"
              :color="tab === t.id ? 'primary' : 'neutral'"
              :variant="tab === t.id ? 'soft' : 'ghost'"
              :icon="t.icon"
              @click="tab = t.id"
            >
              {{ t.label }}
            </UButton>
          </div>

          <div v-if="github.loading" class="flex items-center gap-2 py-6 text-sm text-slate-400">
            <UIcon name="i-lucide-loader" class="h-4 w-4 animate-spin" /> Loading…
          </div>

          <!-- repositories -->
          <section v-else-if="tab === 'repos'" class="space-y-2">
            <!-- manage which repos this board links -->
            <div class="flex items-center justify-between">
              <span class="text-[11px] uppercase tracking-wide text-slate-500">
                Linked to this board
              </span>
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                icon="i-lucide-list-checks"
                @click="managing ? (managing = false) : openManage()"
              >
                {{ managing ? 'Close' : 'Manage repos' }}
              </UButton>
            </div>

            <div
              v-if="managing"
              class="space-y-2 rounded-md border border-slate-700 bg-slate-900/80 p-3"
            >
              <p class="text-[12px] text-slate-400">
                Pick the repositories this board should track. The GitHub connection is shared
                across the account; each board links its own repos.
              </p>
              <div
                v-if="github.loadingAvailable"
                class="flex items-center gap-2 py-3 text-sm text-slate-400"
              >
                <UIcon name="i-lucide-loader" class="h-4 w-4 animate-spin" /> Loading repositories…
              </div>
              <p v-else-if="!github.availableRepos.length" class="py-2 text-sm text-slate-400">
                The installation can’t access any repositories yet.
              </p>
              <div v-else class="max-h-64 space-y-1 overflow-y-auto">
                <button
                  v-for="r in github.availableRepos"
                  :key="r.githubId"
                  type="button"
                  class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition hover:bg-slate-800/60"
                  @click="toggleSelected(r.githubId)"
                >
                  <UIcon
                    :name="selected.has(r.githubId) ? 'i-lucide-check-square' : 'i-lucide-square'"
                    class="h-4 w-4 shrink-0"
                    :class="selected.has(r.githubId) ? 'text-indigo-400' : 'text-slate-500'"
                  />
                  <span class="truncate text-sm text-slate-200">{{ r.owner }}/{{ r.name }}</span>
                  <UBadge v-if="r.private" color="neutral" variant="subtle" size="sm">
                    private
                  </UBadge>
                </button>
              </div>
              <div class="flex items-center justify-end gap-2 pt-1">
                <UButton color="neutral" variant="ghost" size="sm" @click="managing = false">
                  Cancel
                </UButton>
                <UButton
                  color="primary"
                  size="sm"
                  icon="i-lucide-save"
                  :loading="github.savingRepos"
                  @click="saveRepos"
                >
                  Save selection
                </UButton>
              </div>
            </div>

            <p v-if="!github.repos.length && !managing" class="py-4 text-sm text-slate-400">
              No repositories linked yet. Use “Manage repos” to pick which repositories this board
              tracks.
            </p>
            <div
              v-for="repo in github.repos"
              :key="repo.githubId"
              class="rounded-md border border-slate-800 bg-slate-900/60"
            >
              <div class="flex items-center justify-between gap-2 px-3 py-2">
                <button class="flex min-w-0 items-center gap-2 text-left" @click="toggleRepo(repo)">
                  <UIcon
                    :name="
                      expandedRepo === repo.githubId
                        ? 'i-lucide-chevron-down'
                        : 'i-lucide-chevron-right'
                    "
                    class="h-4 w-4 shrink-0 text-slate-500"
                  />
                  <span class="truncate text-sm text-slate-200">
                    {{ repo.owner }}/{{ repo.name }}
                  </span>
                  <UBadge v-if="repo.private" color="neutral" variant="subtle" size="sm">
                    private
                  </UBadge>
                </button>
                <div class="flex items-center gap-2">
                  <span v-if="repo.defaultBranch" class="text-[11px] text-slate-500">
                    {{ repo.defaultBranch }}
                  </span>
                  <ULink
                    :to="github.repoUrl(repo.githubId) ?? '#'"
                    target="_blank"
                    class="text-[11px] text-indigo-400 hover:underline"
                  >
                    Open
                  </ULink>
                </div>
              </div>

              <div
                v-if="expandedRepo === repo.githubId"
                class="space-y-2 border-t border-slate-800 px-3 py-2"
              >
                <div
                  v-for="b in github.branches[repo.githubId] ?? []"
                  :key="b.name"
                  class="flex items-center justify-between gap-2 text-[12px]"
                >
                  <span class="flex items-center gap-1.5 truncate text-slate-300">
                    <UIcon name="i-lucide-git-branch" class="h-3.5 w-3.5 text-slate-500" />
                    {{ b.name }}
                    <UBadge v-if="b.protected" color="warning" variant="subtle" size="sm">
                      protected
                    </UBadge>
                  </span>
                  <code class="text-[10px] text-slate-500">{{ b.headSha.slice(0, 7) }}</code>
                </div>

                <!-- new branch -->
                <div class="flex items-end gap-2 pt-1">
                  <UFormField label="New branch" class="flex-1">
                    <UInput
                      v-model="branchForm.name"
                      placeholder="feature/x"
                      size="sm"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField label="From SHA" class="flex-1">
                    <UInput
                      v-model="branchForm.fromSha"
                      placeholder="commit sha"
                      size="sm"
                      class="w-full"
                    />
                  </UFormField>
                  <UButton
                    size="sm"
                    color="neutral"
                    variant="subtle"
                    icon="i-lucide-git-branch-plus"
                    :loading="creatingBranch"
                    :disabled="!branchForm.name.trim() || !branchForm.fromSha.trim()"
                    @click="createBranch(repo)"
                  />
                </div>
              </div>
            </div>
          </section>

          <!-- pull requests -->
          <section v-else-if="tab === 'pulls'" class="space-y-2">
            <div class="flex justify-end">
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                icon="i-lucide-plus"
                @click="showPrForm = !showPrForm"
              >
                Open PR
              </UButton>
            </div>

            <div
              v-if="showPrForm"
              class="space-y-2 rounded-md border border-slate-700 bg-slate-900/80 p-3"
            >
              <UFormField label="Repository">
                <UDropdownMenu :items="repoMenu" :content="{ align: 'start' }">
                  <UButton
                    color="neutral"
                    variant="subtle"
                    trailing-icon="i-lucide-chevron-down"
                    class="w-full justify-between"
                  >
                    <span class="truncate">
                      {{ prRepo ? `${prRepo.owner}/${prRepo.name}` : 'Choose a repository' }}
                    </span>
                  </UButton>
                </UDropdownMenu>
              </UFormField>
              <UFormField label="Title">
                <UInput v-model="prForm.title" class="w-full" />
              </UFormField>
              <div class="grid grid-cols-2 gap-2">
                <UFormField label="Head branch">
                  <UInput v-model="prForm.head" placeholder="feature/x" class="w-full" />
                </UFormField>
                <UFormField label="Base branch">
                  <UInput v-model="prForm.base" placeholder="main" class="w-full" />
                </UFormField>
              </div>
              <div class="flex justify-end">
                <UButton
                  color="primary"
                  icon="i-lucide-git-pull-request"
                  :loading="openingPr"
                  :disabled="!canOpenPr"
                  @click="openPr"
                >
                  Open pull request
                </UButton>
              </div>
            </div>

            <p v-if="!github.pulls.length" class="py-4 text-sm text-slate-400">
              No pull requests synced.
            </p>
            <div
              v-for="pr in github.pulls"
              :key="`${pr.repoGithubId}-${pr.number}`"
              class="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2"
            >
              <div class="min-w-0">
                <div class="truncate text-sm text-slate-200">
                  <span class="text-slate-500">#{{ pr.number }}</span> {{ pr.title }}
                </div>
                <div class="truncate text-[11px] text-slate-500">
                  {{ github.repoFor(pr.repoGithubId)?.name }} · {{ pr.headRef }} → {{ pr.baseRef }}
                </div>
              </div>
              <div class="flex items-center gap-2">
                <UBadge
                  :color="pr.merged ? 'primary' : pr.state === 'open' ? 'success' : 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ pr.merged ? 'merged' : pr.state }}
                </UBadge>
                <UButton
                  v-if="pr.state === 'open' && !pr.merged"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-git-merge"
                  :loading="merging === pr.number"
                  @click="merge(pr)"
                />
                <ULink
                  :to="github.pullUrl(pr) ?? '#'"
                  target="_blank"
                  class="text-[11px] text-indigo-400 hover:underline"
                >
                  Open
                </ULink>
              </div>
            </div>
          </section>

          <!-- issues -->
          <section v-else class="space-y-2">
            <p v-if="!github.issues.length" class="py-4 text-sm text-slate-400">
              No issues synced.
            </p>
            <div
              v-for="issue in github.issues"
              :key="`${issue.repoGithubId}-${issue.number}`"
              class="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2"
            >
              <div class="min-w-0">
                <div class="truncate text-sm text-slate-200">
                  <span class="text-slate-500">#{{ issue.number }}</span> {{ issue.title }}
                </div>
                <div class="truncate text-[11px] text-slate-500">
                  {{ github.repoFor(issue.repoGithubId)?.name }}
                  <span v-if="issue.labels.length">· {{ issue.labels.join(', ') }}</span>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <UBadge
                  :color="issue.state === 'open' ? 'success' : 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ issue.state }}
                </UBadge>
                <ULink
                  :to="github.issueUrl(issue) ?? '#'"
                  target="_blank"
                  class="text-[11px] text-indigo-400 hover:underline"
                >
                  Open
                </ULink>
              </div>
            </div>
          </section>
        </template>
      </div>
    </template>
  </UModal>
</template>
