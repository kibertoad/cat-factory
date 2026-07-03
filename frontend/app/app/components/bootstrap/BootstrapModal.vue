<script setup lang="ts">
// Repo bootstrap: launch a "bootstrap repo" run and manage the reference
// architecture list. A run creates a new repository and has a bootstrapper agent
// adapt it (in a sandbox container) — either by cloning a chosen reference
// architecture, or from scratch following a freeform prompt. The modal pairs the
// launch form with the managed base list.
import type { BootstrapStatus, FrameRepoType, ReferenceArchitecture } from '~/types/domain'
// Explicit import (see GitHubPanel): the auto-import name for github/GitHubConnect
// doesn't match the `<GitHubConnect>` tag, so bind it directly.
import GitHubConnect from '~/components/github/GitHubConnect.vue'

const ui = useUiStore()
const bootstrap = useBootstrapStore()
const agentRuns = useAgentRunsStore()
const github = useGitHubStore()
const board = useBoardStore()
const toast = useToast()
const { freeFramePosition, focusFrame } = useFramePlacement()
const { t } = useI18n()
const { confirmAction, toastDone } = useConfirmAction()

const open = computed({
  get: () => ui.bootstrapOpen,
  set: (v: boolean) => {
    if (!v) ui.closeBootstrap()
  },
})

// Load the workspace's reference architectures + recent jobs, plus (best-effort)
// the GitHub repos the user can access so the base form can pick from them.
watch(
  open,
  (isOpen) => {
    if (isOpen) {
      void bootstrap.load()
      void loadGitHubRepos()
    }
  },
  { immediate: true },
)

async function loadGitHubRepos() {
  try {
    await github.probe()
    if (github.connected) await github.load()
  } catch {
    // GitHub integration off / unreachable → the repo picker just isn't offered.
  }
}

/** Existing GitHub repos (accessible to the workspace) as `owner/name` options. */
const repoOptions = computed(() =>
  github.repos.map((r) => ({ label: `${r.owner}/${r.name}`, value: `${r.owner}/${r.name}` })),
)
const hasRepoOptions = computed(() => repoOptions.value.length > 0)

// ---- launch form -----------------------------------------------------------
type LaunchMode = 'reference' | 'scratch'
const mode = ref<LaunchMode>('reference')
const modeItems = computed(() => [
  {
    label: t('bootstrap.mode.reference.label'),
    value: 'reference' as const,
    description: t('bootstrap.mode.reference.description'),
  },
  {
    label: t('bootstrap.mode.scratch.label'),
    value: 'scratch' as const,
    description: t('bootstrap.mode.scratch.description'),
  },
])

const selectedArchId = ref<string | undefined>(undefined)
const repoName = ref('')
const description = ref('')
const isPrivate = ref(true)
const instructions = ref('')
const launching = ref(false)

// The behavioural repo role for the bootstrapped frame; `service` (backend) by default. The
// options are shared with the import modal via useFrameRepoTypeItems.
const selectedType = ref<FrameRepoType>('service')
const typeItems = useFrameRepoTypeItems()

const usingReference = computed(() => mode.value === 'reference')

// Mirror of the backend `slugField` rule (@cat-factory/contracts bootstrap
// schema): the new repo name is a SINGLE GitHub name segment — no "owner/"
// prefix — so reject a bad value inline before we hit the API. Kept in sync with
// the contract regex by hand (the FE can't import the backend contracts package).
const REPO_NAME_RE = /^[A-Za-z0-9_.-]+$/
const repoNameError = computed<string | undefined>(() => {
  const value = repoName.value.trim()
  if (!value) return undefined
  if (value.includes('/')) return t('bootstrap.repoName.error.hasSlash')
  if (!REPO_NAME_RE.test(value)) return t('bootstrap.repoName.error.invalidChars')
  if (value.length > 100) return t('bootstrap.repoName.error.tooLong')
  return undefined
})

const selectedArch = computed(() =>
  bootstrap.architectures.find((a) => a.id === selectedArchId.value),
)

const archOptions = computed(() =>
  bootstrap.architectures.map((a) => ({
    label: `${a.name} · ${a.repoOwner}/${a.repoName}`,
    value: a.id,
  })),
)

// Keep a sensible default selection + mode as the list loads/changes. With no
// reference architectures available, only the from-scratch flow makes sense.
watch(
  () => bootstrap.architectures,
  (list) => {
    if (!selectedArchId.value && list.length) selectedArchId.value = list[0]!.id
    if (!list.length) mode.value = 'scratch'
  },
  { immediate: true },
)

// A bootstrap run pushes into a GitHub repo, so the workspace must be connected
// first (the backend pre-flights the same and 409s otherwise). When the
// integration is on but unconnected, surface the discover-and-link prompt inline
// and block launch until it's bound.
const needsGitHub = computed(() => github.available === true && !github.connected)

// The account the repo must live under — the connected installation's account. The
// run pushes into an existing repo here (cat-factory doesn't create it: a GitHub App
// can't create repos under a personal account, and we'd rather not hold the broad
// Administration permission). The repo must be empty or hold only a prepopulated
// README/.gitignore/license — the push force-overwrites that boilerplate. The
// convenience link opens GitHub's new-repo page prefilled so the user can create it
// in one click.
const repoOwner = computed(() => github.connection?.accountLogin ?? '')
const createRepoUrl = computed(() => {
  const params = new URLSearchParams()
  if (repoOwner.value) params.set('owner', repoOwner.value)
  const name = repoName.value.trim()
  if (name) params.set('name', name)
  const desc = description.value.trim()
  if (desc) params.set('description', desc)
  params.set('visibility', isPrivate.value ? 'private' : 'public')
  return `https://github.com/new?${params.toString()}`
})

const creatingRepo = ref(false)

// The "create repository" button behaves differently per tier. Restricted orgs
// (the default) open GitHub's new-repo page prefilled — cat-factory needs no
// repo-creation permission. Privileged orgs (the connection reports
// `canCreateRepos`) create it programmatically via the backend, with no page.
async function openCreateRepo() {
  const name = repoName.value.trim()
  if (!name || repoNameError.value) return

  if (!github.canCreateRepos) {
    window.open(createRepoUrl.value, '_blank', 'noopener')
    return
  }

  creatingRepo.value = true
  try {
    const repo = await github.createRepo({
      name,
      private: isPrivate.value,
      description: description.value.trim() || undefined,
    })
    toast.add({
      title: t('bootstrap.toast.repoCreated'),
      description: `${repo.owner}/${repo.name}`,
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('bootstrap.toast.repoCreateFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    creatingRepo.value = false
  }
}

// After the repo is created, the App still needs access to it: a "selected
// repositories" installation can't see a brand-new repo, so the run 404s with
// "not accessible to the GitHub App". Link straight to the connected
// installation's settings page, where the user adds the repo to its access list
// in one click — no install/connect round-trip (the workspace is already bound).
const manageInstallUrl = computed(() => {
  const conn = github.connection
  if (!conn) return undefined
  return conn.targetType === 'Organization'
    ? `https://github.com/organizations/${conn.accountLogin}/settings/installations/${conn.installationId}`
    : `https://github.com/settings/installations/${conn.installationId}`
})

function openManageInstall() {
  if (manageInstallUrl.value) window.open(manageInstallUrl.value, '_blank', 'noopener')
}

const canLaunch = computed(() => {
  if (needsGitHub.value) return false
  if (!repoName.value.trim() || repoNameError.value) return false
  return usingReference.value ? !!selectedArchId.value : instructions.value.trim().length > 0
})

async function launch() {
  if (!canLaunch.value) return
  launching.value = true
  try {
    const job = await bootstrap.bootstrap({
      referenceArchitectureId: usingReference.value ? (selectedArchId.value ?? null) : null,
      repoName: repoName.value.trim(),
      description: description.value.trim(),
      private: isPrivate.value,
      instructions: instructions.value.trim(),
      type: selectedType.value,
    })
    if (job.status === 'failed') {
      // The container couldn't even start (pre-flight failure, e.g. the target
      // repo isn't empty) — surfaced synchronously, before any board frame.
      toast.add({
        title: t('bootstrap.toast.failed'),
        description: job.error ?? t('bootstrap.toast.failedFallback'),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    } else {
      // Running: the container is spinning up. A provisional service card now
      // shows on the board and tracks live progress; the run continues in the
      // background and becomes a real, droppable service when it finishes.
      toast.add({
        title: t('bootstrap.toast.started'),
        description: t('bootstrap.toast.startedDesc', { repo: job.repoName }),
        icon: 'i-lucide-loader-circle',
        color: 'info',
      })
      repoName.value = ''
      description.value = ''
      instructions.value = ''
      // Reset the repo role too, so a later bootstrap doesn't silently inherit this one's type.
      selectedType.value = 'service'
      // The provisional frame arrived (bootstrap() refreshed the board). Re-home it to
      // free space so it never overlaps an existing service — the backend places it on a
      // fixed diagonal stagger that can land on top of a large neighbour — then centre the
      // camera on it. Best-effort: the run has already started, so a placement hiccup must
      // NOT surface a bootstrap-failed toast or leave the dialog open — swallow it here
      // rather than letting it reach the outer catch.
      if (job.blockId && board.getBlock(job.blockId)) {
        const id = job.blockId
        try {
          const position = freeFramePosition({ size: board.containerSize(id), exclude: id })
          await board.moveBlock(id, position)
          await focusFrame(id)
        } catch {
          // Placement is cosmetic; the run is tracked on the board regardless.
        }
      }
      // The run is now tracked on the board, so get out of the way: close the
      // dialog as soon as bootstrapping has actually started.
      ui.closeBootstrap()
    }
  } catch (e) {
    toast.add({
      title: t('bootstrap.toast.bootstrapFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    launching.value = false
  }
}

// ---- reference architecture management -------------------------------------
type ArchForm = {
  id: string | null
  name: string
  repoOwner: string
  repoName: string
  description: string
  defaultInstructions: string
}
const blankForm = (): ArchForm => ({
  id: null,
  name: '',
  repoOwner: '',
  repoName: '',
  description: '',
  defaultInstructions: '',
})
const archForm = ref<ArchForm>(blankForm())
const showArchForm = ref(false)
const savingArch = ref(false)
/** The `owner/name` slug picked from the GitHub repo list, when used. */
const archRepoSlug = ref<string | undefined>(undefined)

/** Match the form's current owner/name against an available repo option. */
function slugForForm(): string | undefined {
  if (!archForm.value.repoOwner || !archForm.value.repoName) return undefined
  const slug = `${archForm.value.repoOwner}/${archForm.value.repoName}`
  return repoOptions.value.some((o) => o.value === slug) ? slug : undefined
}

// Picking an existing repo fills owner/name (and seeds the name when still blank).
watch(archRepoSlug, (slug) => {
  if (!slug) return
  const sep = slug.indexOf('/')
  if (sep < 0) return
  archForm.value.repoOwner = slug.slice(0, sep)
  archForm.value.repoName = slug.slice(sep + 1)
  if (!archForm.value.name.trim()) archForm.value.name = archForm.value.repoName
})

function startCreate() {
  archForm.value = blankForm()
  archRepoSlug.value = undefined
  showArchForm.value = true
}
function startEdit(a: ReferenceArchitecture) {
  archForm.value = {
    id: a.id,
    name: a.name,
    repoOwner: a.repoOwner,
    repoName: a.repoName,
    description: a.description,
    defaultInstructions: a.defaultInstructions,
  }
  archRepoSlug.value = slugForForm()
  showArchForm.value = true
}

const canSaveArch = computed(
  () =>
    archForm.value.name.trim() && archForm.value.repoOwner.trim() && archForm.value.repoName.trim(),
)

async function saveArch() {
  if (!canSaveArch.value) return
  savingArch.value = true
  try {
    const body = {
      name: archForm.value.name.trim(),
      repoOwner: archForm.value.repoOwner.trim(),
      repoName: archForm.value.repoName.trim(),
      description: archForm.value.description.trim(),
      defaultInstructions: archForm.value.defaultInstructions.trim(),
    }
    if (archForm.value.id) await bootstrap.updateArchitecture(archForm.value.id, body)
    else await bootstrap.createArchitecture(body)
    showArchForm.value = false
    archForm.value = blankForm()
    archRepoSlug.value = undefined
  } catch (e) {
    toast.add({
      title: t('bootstrap.toast.saveArchFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    savingArch.value = false
  }
}

async function removeArch(a: ReferenceArchitecture) {
  if (!(await confirmAction('remove', a.name))) return
  try {
    await bootstrap.deleteArchitecture(a.id)
    if (selectedArchId.value === a.id) selectedArchId.value = undefined
    toastDone('remove', a.name)
  } catch (e) {
    toast.add({
      title: t('bootstrap.toast.deleteFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}

const statusColor: Record<BootstrapStatus, 'neutral' | 'info' | 'success' | 'error'> = {
  pending: 'neutral',
  running: 'info',
  succeeded: 'success',
  failed: 'error',
}

// Exhaustive status→label map of literal `t(...)` keys (keeps the typed-key drift guard live).
const statusLabel = computed<Record<BootstrapStatus, string>>(() => ({
  pending: t('bootstrap.status.pending'),
  running: t('bootstrap.status.running'),
  succeeded: t('bootstrap.status.succeeded'),
  failed: t('bootstrap.status.failed'),
}))
</script>

<template>
  <UModal v-model:open="open" :title="t('bootstrap.title')" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="space-y-6">
        <p class="text-sm text-slate-400">
          {{ github.canCreateRepos ? t('bootstrap.intro.canCreate') : t('bootstrap.intro.manual') }}
        </p>

        <!-- not connected: a run needs GitHub, so discover & link before launching -->
        <div
          v-if="needsGitHub"
          class="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
        >
          <div class="flex items-start gap-2">
            <UIcon name="i-lucide-plug-zap" class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p class="text-sm text-amber-200/90">
              {{ t('bootstrap.github.prompt') }}
            </p>
          </div>
          <GitHubConnect />
        </div>

        <!-- launch -->
        <section class="space-y-4">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('bootstrap.section.newRepo') }}
          </h3>

          <UFormField :label="t('bootstrap.mode.label')" required>
            <URadioGroup v-model="mode" :items="modeItems" />
          </UFormField>

          <template v-if="usingReference">
            <UFormField
              :label="t('bootstrap.reference.label')"
              :description="t('bootstrap.reference.description')"
              required
            >
              <div v-if="!bootstrap.hasArchitectures" class="text-sm text-slate-400">
                {{ t('bootstrap.reference.empty') }}
              </div>
              <USelect
                v-else
                v-model="selectedArchId"
                :items="archOptions"
                :placeholder="t('bootstrap.reference.placeholder')"
                class="w-full"
              />
            </UFormField>
          </template>

          <UFormField
            :label="t('bootstrap.targetRepo.label')"
            :description="
              repoOwner
                ? t('bootstrap.targetRepo.descWithOwner', { owner: repoOwner })
                : t('bootstrap.targetRepo.descNoOwner')
            "
            required
            :error="repoNameError"
          >
            <div class="space-y-2">
              <div class="flex items-center gap-2">
                <UInput
                  v-model="repoName"
                  :placeholder="t('bootstrap.targetRepo.namePlaceholder')"
                  class="w-full"
                />
                <UButton
                  color="neutral"
                  variant="subtle"
                  :icon="github.canCreateRepos ? 'i-lucide-plus' : 'i-lucide-external-link'"
                  :loading="creatingRepo"
                  :disabled="!repoName.trim() || !!repoNameError"
                  :title="
                    github.canCreateRepos
                      ? t('bootstrap.createRepo.titleNow')
                      : t('bootstrap.createRepo.titleGitHub')
                  "
                  @click="openCreateRepo"
                >
                  {{
                    github.canCreateRepos
                      ? t('bootstrap.createRepo.now')
                      : t('bootstrap.createRepo.onGitHub')
                  }}
                </UButton>
              </div>
              <UButton
                v-if="manageInstallUrl && !github.canCreateRepos"
                color="neutral"
                variant="ghost"
                size="sm"
                icon="i-lucide-shield-check"
                trailing-icon="i-lucide-external-link"
                :title="t('bootstrap.grantAccess.title')"
                @click="openManageInstall"
              >
                {{ t('bootstrap.grantAccess.label') }}
              </UButton>
            </div>
          </UFormField>

          <UFormField
            :label="t('bootstrap.repoType.label')"
            :description="t('bootstrap.repoType.help')"
          >
            <USelect v-model="selectedType" :items="typeItems" value-key="value" class="w-full" />
          </UFormField>

          <UFormField
            :label="t('bootstrap.description.label')"
            :description="t('bootstrap.description.help')"
          >
            <UInput
              v-model="description"
              :placeholder="t('bootstrap.description.placeholder')"
              class="w-full"
            />
          </UFormField>

          <UFormField
            :label="
              usingReference
                ? t('bootstrap.instructions.labelReference')
                : t('bootstrap.instructions.labelScratch')
            "
            :description="
              usingReference
                ? t('bootstrap.instructions.descReference')
                : t('bootstrap.instructions.descScratch')
            "
            :required="!usingReference"
          >
            <UTextarea
              v-model="instructions"
              :rows="usingReference ? 3 : 5"
              :placeholder="
                usingReference
                  ? 'e.g. rename the package to payments, drop the example queue worker'
                  : 'e.g. a TypeScript Hono API with a /health route, Vitest tests, and a Dockerfile'
              "
              class="w-full"
            />
          </UFormField>

          <UFormField :label="t('bootstrap.visibility.label')">
            <div class="flex items-center gap-2">
              <USwitch v-model="isPrivate" />
              <span class="text-sm text-slate-300">{{ t('bootstrap.visibility.private') }}</span>
            </div>
          </UFormField>

          <div class="flex justify-end">
            <UButton
              color="primary"
              icon="i-lucide-rocket"
              :loading="launching"
              :disabled="!canLaunch"
              @click="launch"
            >
              {{ t('bootstrap.launch') }}
            </UButton>
          </div>
        </section>

        <!-- recent jobs -->
        <section v-if="agentRuns.bootstrapJobs.length" class="space-y-2">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('bootstrap.recent.title') }}
          </h3>
          <div
            v-for="job in agentRuns.bootstrapJobs.slice(0, 5)"
            :key="job.id"
            class="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm"
          >
            <div class="min-w-0">
              <div class="truncate text-slate-200">{{ job.repoName }}</div>
              <div class="truncate text-[11px] text-slate-500">
                {{
                  job.referenceArchitectureName
                    ? t('bootstrap.recent.fromArch', { name: job.referenceArchitectureName })
                    : t('bootstrap.recent.fromScratch')
                }}
              </div>
            </div>
            <div class="flex items-center gap-2">
              <ULink
                v-if="job.repoUrl"
                :to="job.repoUrl"
                target="_blank"
                class="text-[11px] text-indigo-400 hover:underline"
              >
                {{ t('bootstrap.recent.open') }}
              </ULink>
              <UBadge :color="statusColor[job.status]" variant="subtle" size="sm">
                {{ statusLabel[job.status] }}
              </UBadge>
            </div>
          </div>
        </section>

        <USeparator />

        <!-- reference architecture management -->
        <section class="space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ t('bootstrap.arch.title') }}
            </h3>
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-plus"
              @click="startCreate"
            >
              {{ t('bootstrap.arch.add') }}
            </UButton>
          </div>

          <div
            v-for="a in bootstrap.architectures"
            :key="a.id"
            class="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2"
          >
            <div class="min-w-0">
              <div class="truncate text-sm text-slate-200">{{ a.name }}</div>
              <div class="truncate text-[11px] text-slate-500">
                {{ a.repoOwner }}/{{ a.repoName }}
              </div>
            </div>
            <div class="flex items-center gap-1">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-pencil"
                @click="startEdit(a)"
              />
              <UButton
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                @click="removeArch(a)"
              />
            </div>
          </div>

          <!-- add / edit form -->
          <div
            v-if="showArchForm"
            class="space-y-3 rounded-md border border-slate-700 bg-slate-900/80 p-3"
          >
            <UFormField
              v-if="hasRepoOptions"
              :label="t('bootstrap.arch.pickRepo.label')"
              :description="t('bootstrap.arch.pickRepo.description')"
            >
              <USelect
                v-model="archRepoSlug"
                :items="repoOptions"
                :placeholder="t('bootstrap.arch.pickRepo.placeholder')"
                class="w-full"
              />
            </UFormField>

            <UFormField
              :label="t('bootstrap.arch.name.label')"
              :description="t('bootstrap.arch.name.description')"
              required
            >
              <UInput
                v-model="archForm.name"
                :placeholder="t('bootstrap.arch.name.placeholder')"
                class="w-full"
              />
            </UFormField>
            <div class="grid grid-cols-2 gap-2">
              <UFormField :label="t('bootstrap.arch.repoOwner')" required>
                <UInput
                  v-model="archForm.repoOwner"
                  :placeholder="t('bootstrap.arch.repoOwnerPlaceholder')"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('bootstrap.arch.repoName')" required>
                <UInput
                  v-model="archForm.repoName"
                  :placeholder="t('bootstrap.arch.repoNamePlaceholder')"
                  class="w-full"
                />
              </UFormField>
            </div>
            <UFormField :label="t('bootstrap.description.label')">
              <UInput
                v-model="archForm.description"
                :placeholder="t('bootstrap.arch.descriptionPlaceholder')"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="t('bootstrap.arch.defaultInstructions.label')"
              :description="t('bootstrap.arch.defaultInstructions.description')"
            >
              <UTextarea
                v-model="archForm.defaultInstructions"
                :rows="2"
                :placeholder="t('bootstrap.arch.defaultInstructions.placeholder')"
                class="w-full"
              />
            </UFormField>
            <div class="flex justify-end gap-2">
              <UButton color="neutral" variant="ghost" @click="showArchForm = false">
                {{ t('common.cancel') }}
              </UButton>
              <UButton
                color="primary"
                :loading="savingArch"
                :disabled="!canSaveArch"
                @click="saveArch"
              >
                {{ archForm.id ? t('common.save') : t('bootstrap.arch.add') }}
              </UButton>
            </div>
          </div>
        </section>
      </div>
    </template>
  </UModal>
</template>
