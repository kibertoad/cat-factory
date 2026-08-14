<script setup lang="ts">
// Source-control panel: connect the workspace, manage the connection (disconnect / resync),
// and browse the projected repos, branches, pull requests and issues the backend caches.
// Mirrors the document-source connect/import surface. Writes (new branch, open/merge PR,
// comment) go straight to the repo via the backend's connection credential.
import type { GitHubPullRequest, GitHubRepo, VcsProvider } from '~/types/domain'
// Explicit imports: the auto-import name for a component nested under a like-named directory
// (github/BranchProtectionPreflight) doesn't match the tag used below, so it would silently
// render as an empty element. Importing by path binds each tag unambiguously.
import BranchProtectionPreflight from './BranchProtectionPreflight.vue'
import VcsConnectSurfaces from '~/components/vcs/VcsConnectSurfaces.vue'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'
import { VCS_PROVIDER_ICONS, VCS_PROVIDER_LABELS } from '~/utils/vcs'

const { t } = useI18n()
const ui = useUiStore()
const access = useWorkspaceAccess()
const github = useGitHubStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { confirm } = useConfirm()

const open = computed({
  get: () => ui.githubOpen,
  set: (v: boolean) => {
    if (!v) ui.closeGitHub()
  },
})
const back = useIntegrationBack(open)

// Provider-aware chrome: once connected, the panel is titled for the provider the workspace
// actually connected; before that it names the sole connectable provider, or stays neutral when
// the deployment serves several. Brand names are verbatim in every locale (see `~/utils/vcs`).
const chromeProvider = computed(() => github.surfaceProvider)
const panelTitle = computed(() =>
  chromeProvider.value ? VCS_PROVIDER_LABELS[chromeProvider.value] : t('vcs.panel.title'),
)
const providerIcon = computed(() =>
  chromeProvider.value ? VCS_PROVIDER_ICONS[chromeProvider.value] : 'i-lucide-git-branch',
)

// What the connection line says under the account: a GitHub App connection is identified by its
// installation, a PAT connection by the credential it rides. Keyed by an exhaustive Record of
// literal `t()` keys, so a new provider fails the typecheck rather than rendering App vocabulary.
const CONNECTION_META: Record<VcsProvider, () => string> = {
  github: () =>
    t('github.panel.installationMeta', {
      targetType: github.connection?.targetType ?? '',
      id: github.connection?.installationId ?? '',
    }),
  gitlab: () => t('vcs.panel.patMeta'),
}
const connectionMeta = computed(() => CONNECTION_META[github.provider]())

// GitHub opens PULL requests, GitLab opens MERGE requests, and the panel renders both providers'
// rows through one component. The vocabulary is therefore a per-provider set of STATIC catalog
// keys (an exhaustive Record, so a new provider fails the typecheck rather than shipping GitHub's
// nouns), resolved off the connected provider — the panel only ever lists one connection's repos.
const PULL_TERMS = {
  github: {
    tab: 'vcs.panel.pulls.github.tab',
    open: 'vcs.panel.pulls.github.open',
    openSubmit: 'vcs.panel.pulls.github.openSubmit',
    merge: 'vcs.panel.pulls.github.merge',
    none: 'vcs.panel.pulls.github.none',
    opened: 'vcs.panel.pulls.github.opened',
    mergedToast: 'vcs.panel.pulls.github.mergedToast',
    openFailed: 'vcs.panel.pulls.github.openFailed',
  },
  gitlab: {
    tab: 'vcs.panel.pulls.gitlab.tab',
    open: 'vcs.panel.pulls.gitlab.open',
    openSubmit: 'vcs.panel.pulls.gitlab.openSubmit',
    merge: 'vcs.panel.pulls.gitlab.merge',
    none: 'vcs.panel.pulls.gitlab.none',
    opened: 'vcs.panel.pulls.gitlab.opened',
    mergedToast: 'vcs.panel.pulls.gitlab.mergedToast',
    openFailed: 'vcs.panel.pulls.gitlab.openFailed',
  },
} as const satisfies Record<VcsProvider, Record<string, string>>
const pullTerms = computed(() => PULL_TERMS[github.provider])

// What the repo picker can offer, and why a repo might be missing from it, differ by how the
// workspace authenticates rather than by provider: an App installation is shared across the
// account and has its own access list, a pasted token reaches exactly what its owner does.
const isAppConnection = computed(() => github.connection?.method === 'app')

// On open: refresh projections when connected. The not-connected state renders
// <GitHubConnect>, which discovers and links installations on its own.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    if (github.connected) void github.load()
  },
  { immediate: true },
)

async function disconnect() {
  const ok = await confirm({
    title: t('vcs.panel.confirmDisconnect.title', {
      provider: VCS_PROVIDER_LABELS[github.provider],
    }),
    description: t('vcs.panel.confirmDisconnect.body'),
    variant: 'destructive',
    confirmLabel: t('common.disconnect'),
    icon: 'i-lucide-unplug',
  })
  if (!ok) return
  try {
    await github.disconnect()
    toast.add({
      title: t('vcs.panel.toast.disconnected', { provider: VCS_PROVIDER_LABELS[github.provider] }),
      icon: 'i-lucide-unplug',
    })
  } catch (e) {
    present(e, 'github.panel.errors.disconnect')
  }
}

async function resync(full = false) {
  try {
    const { status } = await github.resync({ full })
    toast.add({
      title: t('github.panel.toast.resync', { status }),
      icon: 'i-lucide-refresh-cw',
      color: 'info',
    })
  } catch (e) {
    present(e, 'github.panel.errors.resync')
  }
}

// ---- browse ----------------------------------------------------------------
type Tab = 'repos' | 'pulls' | 'issues'
const tab = ref<Tab>('repos')
const tabs = computed<{ id: Tab; label: string; icon: string }[]>(() => [
  { id: 'repos', label: t('github.panel.tabs.repos'), icon: 'i-lucide-folder-git-2' },
  { id: 'pulls', label: t(pullTerms.value.tab), icon: 'i-lucide-git-pull-request' },
  { id: 'issues', label: t('github.panel.tabs.issues'), icon: 'i-lucide-circle-dot' },
])

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
    present(e, 'github.panel.errors.loadRepos')
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
    toast.add({
      title: t('github.panel.toast.reposUpdated'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'github.panel.errors.updateRepos')
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
      present(e, 'github.panel.errors.loadBranches')
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
    toast.add({
      title: t('github.panel.toast.branchCreated', { name }),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'github.panel.errors.createBranch')
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
    toast.add({ title: t(pullTerms.value.opened), icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    present(e, pullTerms.value.openFailed)
  } finally {
    openingPr.value = false
  }
}

// PR / issue state labels. The states are a statically-known enum (open/closed,
// plus the derived `merged` for PRs), so the labels are literal `t()` keys — one
// per member — which keeps the typed-message-keys drift guard live.
function prStateLabel(pr: GitHubPullRequest): string {
  if (pr.merged) return t('github.panel.prState.merged')
  return pr.state === 'open' ? t('github.panel.prState.open') : t('github.panel.prState.closed')
}
function issueStateLabel(state: GitHubPullRequest['state']): string {
  return state === 'open' ? t('github.panel.issueState.open') : t('github.panel.issueState.closed')
}

const merging = ref<number | null>(null)
async function merge(pr: GitHubPullRequest) {
  merging.value = pr.number
  try {
    await github.mergePullRequest(pr.repoGithubId, pr.number, { method: 'squash' })
    toast.add({
      title: t(pullTerms.value.mergedToast, { number: pr.number }),
      icon: 'i-lucide-git-merge',
      color: 'success',
    })
  } catch (e) {
    present(e, 'github.panel.errors.merge')
  } finally {
    merging.value = null
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="panelTitle" :ui="{ content: 'max-w-2xl' }">
    <template #title>
      <IntegrationBackTitle :title="panelTitle" @back="back" />
    </template>
    <template #body>
      <div class="space-y-5">
        <!-- not connected: connect -->
        <VcsConnectSurfaces v-if="!github.connected" :app-intro="t('github.panel.connectIntro')" />

        <!-- connected: manage + browse -->
        <template v-else>
          <!-- connection header -->
          <div
            class="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2"
          >
            <div class="flex items-center gap-2 min-w-0">
              <UIcon :name="providerIcon" class="h-5 w-5 text-slate-300" />
              <div class="min-w-0">
                <div class="truncate text-sm text-slate-200">
                  {{ github.connection?.accountLogin }}
                </div>
                <div class="text-[11px] text-slate-500">{{ connectionMeta }}</div>
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
                {{ t('github.panel.resync') }}
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-history"
                :disabled="github.syncing"
                @click="resync(true)"
              >
                {{ t('github.panel.backfill') }}
              </UButton>
              <UButton
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-unplug"
                :aria-label="t('github.panel.disconnect')"
                @click="disconnect"
              />
            </div>
          </div>

          <!-- tabs -->
          <div class="flex gap-1">
            <UButton
              v-for="tabItem in tabs"
              :key="tabItem.id"
              size="sm"
              :color="tab === tabItem.id ? 'primary' : 'neutral'"
              :variant="tab === tabItem.id ? 'soft' : 'ghost'"
              :icon="tabItem.icon"
              @click="
                () => {
                  tab = tabItem.id
                }
              "
            >
              {{ tabItem.label }}
            </UButton>
          </div>

          <div v-if="github.loading" class="flex items-center gap-2 py-6 text-sm text-slate-400">
            <UIcon name="i-lucide-loader" class="h-4 w-4 animate-spin" />
            {{ t('github.panel.loading') }}
          </div>

          <!-- repositories -->
          <section v-else-if="tab === 'repos'" class="space-y-2">
            <!-- manage which repos this board links -->
            <div class="flex items-center justify-between">
              <span class="text-[11px] uppercase tracking-wide text-slate-500">
                {{ t('github.panel.linkedToBoard') }}
              </span>
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                icon="i-lucide-list-checks"
                @click="
                  () => {
                    managing ? (managing = false) : openManage()
                  }
                "
              >
                {{ managing ? t('common.close') : t('github.panel.manageRepos') }}
              </UButton>
            </div>

            <div
              v-if="managing"
              class="space-y-2 rounded-md border border-slate-700 bg-slate-900/80 p-3"
            >
              <p class="text-[12px] text-slate-400">
                {{
                  isAppConnection ? t('vcs.panel.manageHintApp') : t('vcs.panel.manageHintToken')
                }}
              </p>
              <div
                v-if="github.loadingAvailable"
                class="flex items-center gap-2 py-3 text-sm text-slate-400"
              >
                <UIcon name="i-lucide-loader" class="h-4 w-4 animate-spin" />
                {{ t('github.panel.loadingRepos') }}
              </div>
              <p v-else-if="!github.availableRepos.length" class="py-2 text-sm text-slate-400">
                {{
                  isAppConnection
                    ? t('vcs.panel.noAvailableReposApp')
                    : t('vcs.panel.noAvailableReposToken')
                }}
              </p>
              <div v-else class="max-h-64 space-y-1 overflow-y-auto">
                <button
                  v-for="r in github.availableRepos"
                  :key="r.githubId"
                  type="button"
                  class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start transition hover:bg-slate-800/60"
                  @click="toggleSelected(r.githubId)"
                >
                  <UIcon
                    :name="selected.has(r.githubId) ? 'i-lucide-check-square' : 'i-lucide-square'"
                    class="h-4 w-4 shrink-0"
                    :class="selected.has(r.githubId) ? 'text-indigo-400' : 'text-slate-500'"
                  />
                  <span class="truncate text-sm text-slate-200">{{ r.owner }}/{{ r.name }}</span>
                  <UBadge v-if="r.private" color="neutral" variant="subtle" size="sm">
                    {{ t('github.panel.private') }}
                  </UBadge>
                </button>
              </div>
              <div class="flex items-center justify-end gap-2 pt-1">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  @click="
                    () => {
                      managing = false
                    }
                  "
                >
                  {{ t('common.cancel') }}
                </UButton>
                <UButton
                  color="primary"
                  size="sm"
                  icon="i-lucide-save"
                  :loading="github.savingRepos"
                  @click="saveRepos"
                >
                  {{ t('github.panel.saveSelection') }}
                </UButton>
              </div>
            </div>

            <p v-if="!github.repos.length && !managing" class="py-4 text-sm text-slate-400">
              {{ t('github.panel.noLinkedRepos') }}
            </p>

            <!-- Whether the host actually protects what an agent run pushes to. Placed above the
                 repo list because it is a posture check across ALL of them, not a per-repo
                 attribute. Admin-only to match the route: the probe spends the installation's
                 GitHub rate limit, which the CI gate and the merger share, so it is gated rather
                 than merely read-only. Hidden rather than disabled — a member has nothing to do
                 with a control whose result is the operator's to act on. -->
            <BranchProtectionPreflight
              v-if="github.repos.length && access.canManageIntegrations.value"
              class="rounded-md border border-slate-800 bg-slate-900/40 p-3"
            />

            <div
              v-for="repo in github.repos"
              :key="repo.githubId"
              class="rounded-md border border-slate-800 bg-slate-900/60"
            >
              <div class="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  class="flex min-w-0 items-center gap-2 text-start"
                  @click="toggleRepo(repo)"
                >
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
                    {{ t('github.panel.private') }}
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
                    {{ t('github.panel.open') }}
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
                      {{ t('github.panel.protected') }}
                    </UBadge>
                  </span>
                  <code class="text-[10px] text-slate-500">{{ b.headSha.slice(0, 7) }}</code>
                </div>

                <!-- new branch -->
                <div class="flex items-end gap-2 pt-1">
                  <UFormField :label="t('github.panel.newBranch')" class="flex-1">
                    <UInput
                      v-model="branchForm.name"
                      placeholder="feature/x"
                      size="sm"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField :label="t('github.panel.fromSha')" class="flex-1">
                    <UInput
                      v-model="branchForm.fromSha"
                      :placeholder="t('github.panel.commitShaPlaceholder')"
                      size="sm"
                      class="w-full"
                    />
                  </UFormField>
                  <UButton
                    size="sm"
                    color="neutral"
                    variant="subtle"
                    icon="i-lucide-git-branch-plus"
                    :aria-label="t('github.panel.createBranch')"
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
                @click="
                  () => {
                    showPrForm = !showPrForm
                  }
                "
              >
                {{ t(pullTerms.open) }}
              </UButton>
            </div>

            <div
              v-if="showPrForm"
              class="space-y-2 rounded-md border border-slate-700 bg-slate-900/80 p-3"
            >
              <UFormField :label="t('github.panel.repository')">
                <UDropdownMenu :items="repoMenu" :content="{ align: 'start' }">
                  <UButton
                    color="neutral"
                    variant="subtle"
                    trailing-icon="i-lucide-chevron-down"
                    class="w-full justify-between"
                  >
                    <span class="truncate">
                      {{
                        prRepo
                          ? `${prRepo.owner}/${prRepo.name}`
                          : t('github.panel.chooseRepository')
                      }}
                    </span>
                  </UButton>
                </UDropdownMenu>
              </UFormField>
              <UFormField :label="t('github.panel.prTitle')">
                <UInput v-model="prForm.title" class="w-full" />
              </UFormField>
              <div class="grid grid-cols-2 gap-2">
                <UFormField :label="t('github.panel.headBranch')">
                  <UInput v-model="prForm.head" placeholder="feature/x" class="w-full" />
                </UFormField>
                <UFormField :label="t('github.panel.baseBranch')">
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
                  {{ t(pullTerms.openSubmit) }}
                </UButton>
              </div>
            </div>

            <p v-if="!github.pulls.length" class="py-4 text-sm text-slate-400">
              {{ t(pullTerms.none) }}
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
                  {{ prStateLabel(pr) }}
                </UBadge>
                <UButton
                  v-if="pr.state === 'open' && !pr.merged"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-git-merge"
                  :aria-label="t(pullTerms.merge)"
                  :loading="merging === pr.number"
                  @click="merge(pr)"
                />
                <ULink
                  :to="github.pullUrl(pr) ?? '#'"
                  target="_blank"
                  class="text-[11px] text-indigo-400 hover:underline"
                >
                  {{ t('github.panel.open') }}
                </ULink>
              </div>
            </div>
          </section>

          <!-- issues -->
          <section v-else class="space-y-2">
            <p v-if="!github.issues.length" class="py-4 text-sm text-slate-400">
              {{ t('github.panel.noIssues') }}
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
                  {{ issueStateLabel(issue.state) }}
                </UBadge>
                <ULink
                  :to="github.issueUrl(issue) ?? '#'"
                  target="_blank"
                  class="text-[11px] text-indigo-400 hover:underline"
                >
                  {{ t('github.panel.open') }}
                </ULink>
              </div>
            </div>
          </section>
        </template>
      </div>
    </template>
  </UModal>
</template>
