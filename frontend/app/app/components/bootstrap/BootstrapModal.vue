<script setup lang="ts">
// Repo bootstrap: launch a "bootstrap repo" run and manage the reference
// architecture list. A run creates a new repository and has a bootstrapper agent
// adapt it (in a sandbox container) — either by cloning a chosen reference
// architecture, or from scratch following a freeform prompt. The modal pairs the
// launch form with the managed base list.
import type { BootstrapReferenceReason } from '@cat-factory/contracts'
import type { BootstrapStatus, FrameRepoType, ReferenceArchitecture } from '~/types/domain'
import { apiErrorEnvelope } from '~/composables/api/errors'
import {
  serviceDirectoryLeaf,
  serviceDirectoryParent,
} from '~/components/bootstrap/BootstrapModal.logic'
import RepoTreeBrowser from '~/components/github/RepoTreeBrowser.vue'
import VcsConnectSurfaces from '~/components/vcs/VcsConnectSurfaces.vue'
import { appInstallationManageUrl, newRepoUrl, VCS_PROVIDER_LABELS } from '~/utils/vcs'

const ui = useUiStore()
const bootstrap = useBootstrapStore()
const agentRuns = useAgentRunsStore()
const github = useGitHubStore()
const board = useBoardStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { freeFramePosition, focusFrame } = useFramePlacement()
const { t } = useI18n()
const { confirmAction, toastDone } = useConfirmAction()

const open = computed(() => ui.bootstrapOpen)

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

// ---- where the service LANDS ----------------------------------------------
// A second, independent axis from `mode` (which says where the CONTENT comes from): a run
// either creates a repository of its own, or writes the service into a subdirectory of an
// existing monorepo and opens a pull request against it. The monorepo path adds the human
// adoption review between the survey and the write, which is why the two are not one control.
type Target = 'new-repo' | 'monorepo'
const target = ref<Target>('new-repo')
const targetItems = computed(() => [
  {
    label: t('bootstrap.target.newRepo.label'),
    value: 'new-repo' as const,
    description: t('bootstrap.target.newRepo.description'),
  },
  {
    label: t('bootstrap.target.monorepo.label'),
    value: 'monorepo' as const,
    description: t('bootstrap.target.monorepo.description'),
  },
])
const intoMonorepo = computed(() => target.value === 'monorepo')

/** The projected repo the new service lands in, by numeric id. */
const monorepoRepoId = ref<number | undefined>(undefined)
const monorepoDirectory = ref('')

const monorepoRepoItems = computed(() =>
  github.repos.map((r) => ({ label: `${r.owner}/${r.name}`, value: r.githubId })),
)

// `repoPathSegments` is the backend's `normalizeServiceDirectory` reduction: the path becomes
// an agent's working directory, so a value that could escape the checkout is refused here
// rather than at the API.
const directorySegments = computed(() => repoPathSegments(monorepoDirectory.value))
const directoryError = computed<string | undefined>(() => {
  if (!monorepoDirectory.value.trim()) return undefined
  if (!directorySegments.value.length) return t('bootstrap.monorepo.directory.error.empty')
  if (directorySegments.value.some((seg) => seg === '..')) {
    return t('bootstrap.monorepo.directory.error.escapes')
  }
  return undefined
})

// ---- exploring the monorepo for the directory's home -----------------------
// The target must NOT exist, so nothing in the tree can BE it: the tree picks the enclosing
// folder and hands back that folder plus the leaf (see `BootstrapModal.logic`, which owns the
// two readings of the typed value).
const directoryLeaf = computed(() => serviceDirectoryLeaf(monorepoDirectory.value, repoName.value))
const browsingDirectory = ref(false)
// The folder the tree opens at, captured when the browser is OPENED rather than read live off
// the field: as a computed it would re-navigate the listing on every keystroke in the input.
const directoryBrowseStart = ref('')

function toggleDirectoryBrowse() {
  if (!browsingDirectory.value) {
    directoryBrowseStart.value = serviceDirectoryParent(monorepoDirectory.value)
  }
  browsingDirectory.value = !browsingDirectory.value
}

/** The tree emits the composed path: the folder it was standing in plus the leaf it was given. */
function placeDirectory(path: string | undefined) {
  if (!path) return
  monorepoDirectory.value = path
  browsingDirectory.value = false
}

// Landing in a monorepo needs no NEW repository, so the repo name is the SERVICE's name (and
// seeds the directory's leaf); the create-repo affordances below are for the other target.
watch([intoMonorepo, repoName], ([into, name]) => {
  if (!into || !name.trim() || monorepoDirectory.value.trim()) return
  monorepoDirectory.value = `services/${name.trim()}`
})

// UX-18: prompt before discarding a half-filled launch form on Escape / backdrop / the X.
// The modal keeps its fields across opens (no reset watcher), so the baseline is whatever
// the form held when it opened — a close only prompts once the user has typed something
// new. Only the typed launch fields are guarded; the reference-architecture sub-form has
// its own Cancel/Save. Declared here (below the launch-form refs) because the guard reads
// its initial baseline synchronously.
const { requestClose } = useUnsavedGuard({
  open,
  close: () => ui.closeBootstrap(),
  saving: () => launching.value,
  snapshot: () => ({
    repoName: repoName.value.trim(),
    description: description.value.trim(),
    instructions: instructions.value.trim(),
  }),
})

// The template's v-model binding: dismissal (Escape / backdrop) routes through the guard.
// Declared after the guard so the setter's `requestClose` reference is never in its TDZ.
const modalOpen = computed({
  get: () => open.value,
  set: (v: boolean) => {
    if (!v) void requestClose()
  },
})

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

// ---- a launch refused for its reference architecture -----------------------
// The backend pre-flights the template against the workspace's source-control connection BEFORE
// it records anything, so this refusal costs the user nothing except a correction: the run does
// not exist, the board has no card, and every other field of this form is still filled in. That
// is what the alert is for. A toast would say the same words and then disappear, leaving the
// person to work out which of the two repositories in this dialog was the problem.
interface ReferenceRefusal {
  reason: BootstrapReferenceReason
  /** The entry that named the repository, so the fix opens the right one of several. */
  architectureId: string | null
  /** `owner/name` as the entry spells it. */
  repo: string | null
}

const referenceRefusal = ref<ReferenceRefusal | null>(null)

/** The refusal a failed launch carries, or null when it failed for anything else. */
function referenceRefusalOf(error: unknown): ReferenceRefusal | null {
  const details = (apiErrorEnvelope(error)?.details ?? {}) as Record<string, unknown>
  const reason = details.reason
  if (reason !== 'reference_repo_not_found' && reason !== 'reference_repo_unreadable') return null
  return {
    reason,
    architectureId:
      typeof details.referenceArchitectureId === 'string' ? details.referenceArchitectureId : null,
    repo: typeof details.repo === 'string' ? details.repo : null,
  }
}

const referenceRefusalMessage = computed(() => {
  const refusal = referenceRefusal.value
  if (!refusal) return ''
  const repo = refusal.repo ?? t('bootstrap.reference.refusal.unnamedRepo')
  return refusal.reason === 'reference_repo_not_found'
    ? t('bootstrap.reference.refusal.notFound', { repo })
    : t('bootstrap.reference.refusal.unreadable', { repo })
})

/**
 * Whether correcting the ENTRY is the fix. Only for `not_found`: an unreadable probe says nothing
 * about the entry, so offering to edit it there would send someone to change a value that is
 * very likely already right.
 */
const referenceRefusalIsFixable = computed(
  () => referenceRefusal.value?.reason === 'reference_repo_not_found',
)

/** Open the refused entry's edit form, prefilled, leaving the launch form untouched. */
function editRefusedArchitecture() {
  const id = referenceRefusal.value?.architectureId
  const arch = bootstrap.architectures.find((a) => a.id === id)
  if (arch) startEdit(arch)
}

// A refusal is about ONE entry as it was, so picking a different reference architecture makes it
// stale, and a stale error banner reads as a live one. Reopening the dialog clears it for the same
// reason: the form deliberately keeps its fields across opens, but a refusal is not a field, it is
// a claim about a check that has not been made again. Saving an edit clears it too (`saveArch`).
watch([open, selectedArchId], () => {
  referenceRefusal.value = null
})

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

// A bootstrap run pushes into a repo on the connected host, so the workspace must be
// connected first (the backend pre-flights the same and 409s otherwise). When the
// integration is on but unconnected, surface the connect prompt inline and block launch
// until it's bound.
const needsConnection = computed(() => github.available === true && !github.connected)

// The host this modal is about: the connected one, or the only one the deployment could
// connect while nothing is bound. Null where it offers several and none is connected, so
// `provider`'s own "what is connected" default can never send a GitLab deployment to github.com.
const hostProvider = computed(() => github.surfaceProvider)
const providerLabel = computed(() =>
  hostProvider.value ? VCS_PROVIDER_LABELS[hostProvider.value] : '',
)

// The account the repo must live under — the connected account. The run pushes into an
// existing repo here (cat-factory doesn't create it: a GitHub App can't create repos under a
// personal account, and we'd rather not hold the broad Administration permission). The repo
// must be empty or hold only a prepopulated README/.gitignore/license — the push
// force-overwrites that boilerplate. The convenience link opens the host's own new-repo page,
// prefilled, and is ABSENT for any host `~/utils/vcs` can't name (an unresolved provider, or a
// deployment whose API base does not invert to a web host); the copy and the button both key off
// it, so what the intro promises and what renders cannot disagree. The host now comes off the
// connection (or, before one exists, off the connect option), so a GitLab deployment that states
// one gets the button back rather than losing it to the provider alone.
const repoOwner = computed(() => github.connection?.accountLogin ?? '')
const createRepoUrl = computed(() =>
  newRepoUrl(hostProvider.value, github.surfaceWebUrl, {
    owner: repoOwner.value,
    name: repoName.value.trim(),
    description: description.value.trim(),
    private: isPrivate.value,
  }),
)

const creatingRepo = ref(false)

// The "create repository" button behaves differently per tier. Restricted orgs
// (the default) open the host's new-repo page — cat-factory needs no
// repo-creation permission. Privileged orgs (the connection reports
// `canCreateRepos`) create it programmatically via the backend, with no page.
async function openCreateRepo() {
  const name = repoName.value.trim()
  if (!name || repoNameError.value) return

  if (!github.canCreateRepos) {
    // The button is hidden without a resolved host, so there is always a URL here; the guard
    // keeps that a local fact rather than an assumption about the template.
    if (createRepoUrl.value) window.open(createRepoUrl.value, '_blank', 'noopener')
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
    present(e, 'bootstrap.toast.repoCreateFailed')
  } finally {
    creatingRepo.value = false
  }
}

// After the repo is created, the App still needs access to it: a "selected
// repositories" installation can't see a brand-new repo, so the run 404s with
// "not accessible to the GitHub App". Link straight to the connected
// installation's settings page, where the user adds the repo to its access list
// in one click — no install/connect round-trip (the workspace is already bound).
// Absent on a PAT connection, which grants no per-installation access (see `~/utils/vcs`).
const manageInstallUrl = computed(() => appInstallationManageUrl(github.connection))

function openManageInstall() {
  if (manageInstallUrl.value) window.open(manageInstallUrl.value, '_blank', 'noopener')
}

const canLaunch = computed(() => {
  if (needsConnection.value) return false
  if (!repoName.value.trim() || repoNameError.value) return false
  if (intoMonorepo.value) {
    if (!monorepoRepoId.value) return false
    if (!monorepoDirectory.value.trim() || directoryError.value) return false
  }
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
      ...(intoMonorepo.value && monorepoRepoId.value
        ? {
            monorepo: {
              repoGithubId: monorepoRepoId.value,
              directory: monorepoDirectory.value.trim(),
            },
          }
        : {}),
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
        // A monorepo run does not run straight through: it surveys, then waits for the
        // reviewer. Saying "bootstrapping…" there would set the wrong expectation about who
        // the next move belongs to.
        description: job.monorepo
          ? t('bootstrap.toast.startedMonorepoDesc', { directory: job.monorepo.directory })
          : t('bootstrap.toast.startedDesc', { repo: job.repoName }),
        icon: 'i-lucide-loader-circle',
        color: 'info',
      })
      repoName.value = ''
      description.value = ''
      instructions.value = ''
      monorepoDirectory.value = ''
      browsingDirectory.value = false
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
    // A reference-architecture refusal is kept on the form as well as toasted: the run was never
    // recorded, so what the user needs is the one field to change and everything else left alone,
    // which a toast cannot hold still long enough to give them.
    referenceRefusal.value = referenceRefusalOf(e)
    present(e, 'bootstrap.toast.bootstrapFailed')
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
    // The entry the refusal named has been rewritten, so the refusal no longer describes it.
    // Whether the new value is reachable is the next launch's question, not this save's.
    referenceRefusal.value = null
    showArchForm.value = false
    archForm.value = blankForm()
    archRepoSlug.value = undefined
  } catch (e) {
    present(e, 'bootstrap.toast.saveArchFailed')
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
    present(e, 'bootstrap.toast.deleteFailed')
  }
}

const statusColor: Record<BootstrapStatus, 'neutral' | 'info' | 'success' | 'error' | 'warning'> = {
  pending: 'neutral',
  running: 'info',
  // A parked run is not "in progress": it is waiting on a person, which is what `warning`
  // says on every other surface where the platform is blocked on its user.
  awaiting_review: 'warning',
  succeeded: 'success',
  failed: 'error',
}

// Exhaustive status→label map of literal `t(...)` keys (keeps the typed-key drift guard live).
const statusLabel = computed<Record<BootstrapStatus, string>>(() => ({
  pending: t('bootstrap.status.pending'),
  running: t('bootstrap.status.running'),
  awaiting_review: t('bootstrap.status.awaitingReview'),
  succeeded: t('bootstrap.status.succeeded'),
  failed: t('bootstrap.status.failed'),
}))
</script>

<template>
  <UModal v-model:open="modalOpen" :title="t('bootstrap.title')" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="space-y-6">
        <!-- Three states, because each promises the user something different about the repo.
             cat-factory creates it (privileged App tier, so a provider is always resolved);
             the user creates it in one click on a host we can name; or the user creates it
             themselves somewhere we cannot name, where promising a click below would be a lie
             (the button is absent for exactly the same reason). -->
        <p class="text-sm text-slate-400">
          {{
            intoMonorepo
              ? t('bootstrap.monorepo.intro')
              : github.canCreateRepos
                ? t('vcs.bootstrap.introCanCreate', { provider: providerLabel })
                : createRepoUrl
                  ? t('vcs.bootstrap.introManual', { provider: providerLabel })
                  : t('vcs.bootstrap.introManualAny')
          }}
        </p>

        <!-- not connected: a run pushes to the host, so connect before launching. Offer
             whichever methods the deployment serves, never just the GitHub App. -->
        <div
          v-if="needsConnection"
          class="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
        >
          <div class="flex items-start gap-2">
            <UIcon name="i-lucide-plug-zap" class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p class="text-sm text-amber-200/90">
              {{ t('vcs.bootstrap.connectPrompt') }}
            </p>
          </div>
          <VcsConnectSurfaces />
        </div>

        <!-- launch -->
        <section class="space-y-4">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('bootstrap.section.newRepo') }}
          </h3>

          <UFormField :label="t('bootstrap.target.label')" required>
            <URadioGroup v-model="target" :items="targetItems" />
          </UFormField>

          <!-- Landing in an existing monorepo: pick the repository and the subdirectory. The
               run surveys the monorepo's conventions against the template's and PARKS for a
               human adoption review before it writes anything. -->
          <template v-if="intoMonorepo">
            <UFormField
              :label="t('bootstrap.monorepo.repo.label')"
              :description="t('bootstrap.monorepo.repo.description')"
              required
            >
              <div v-if="!monorepoRepoItems.length" class="text-sm text-slate-400">
                {{ t('bootstrap.monorepo.repo.empty') }}
              </div>
              <USelect
                v-else
                v-model="monorepoRepoId"
                :items="monorepoRepoItems"
                :placeholder="t('bootstrap.monorepo.repo.placeholder')"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="t('bootstrap.monorepo.directory.label')"
              :description="t('bootstrap.monorepo.directory.description')"
              required
              :error="directoryError"
            >
              <div class="space-y-2">
                <div class="flex items-center gap-2">
                  <UInput
                    v-model="monorepoDirectory"
                    :placeholder="t('bootstrap.monorepo.directory.placeholder')"
                    class="flex-1"
                  />
                  <UButton
                    v-if="monorepoRepoId !== undefined"
                    variant="soft"
                    color="neutral"
                    icon="i-lucide-folder-search"
                    :title="t('bootstrap.monorepo.directory.browse')"
                    :aria-label="t('bootstrap.monorepo.directory.browse')"
                    data-testid="bootstrap-directory-browse"
                    @click="toggleDirectoryBrowse()"
                  />
                </div>

                <!-- The tree answers WHERE, never WHAT: with no name to place yet it could
                     decide nothing, so say that instead of listing a repo for nothing. -->
                <div
                  v-if="browsingDirectory && monorepoRepoId !== undefined"
                  class="rounded-md border border-slate-800 bg-slate-900/40 p-2"
                >
                  <p class="mb-2 text-xs text-slate-400">
                    {{
                      directoryLeaf
                        ? t('bootstrap.monorepo.directory.browseHint')
                        : t('bootstrap.monorepo.directory.browseNeedsName')
                    }}
                  </p>
                  <RepoTreeBrowser
                    v-if="directoryLeaf"
                    :repo-github-id="monorepoRepoId"
                    mode="dir"
                    :new-dir-name="directoryLeaf"
                    :model-value="monorepoDirectory"
                    :start-path="directoryBrowseStart"
                    @update:model-value="placeDirectory"
                  />
                </div>
              </div>
            </UFormField>
          </template>

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

            <!-- The launch was refused for the template, before anything was recorded. The
                 remedy lives in this same dialog, so the alert carries the jump to it rather
                 than describing where to go. -->
            <UAlert
              v-if="referenceRefusal"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :title="t('bootstrap.reference.refusal.title')"
              :description="referenceRefusalMessage"
              data-testid="bootstrap-reference-refusal"
            >
              <template v-if="referenceRefusalIsFixable" #actions>
                <UButton
                  color="error"
                  variant="soft"
                  size="xs"
                  icon="i-lucide-pencil"
                  @click="editRefusedArchitecture"
                >
                  {{ t('bootstrap.reference.refusal.edit') }}
                </UButton>
              </template>
            </UAlert>
          </template>

          <UFormField
            :label="
              intoMonorepo ? t('bootstrap.serviceName.label') : t('bootstrap.targetRepo.label')
            "
            :description="
              intoMonorepo
                ? t('bootstrap.serviceName.description')
                : repoOwner
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
                <!-- Creating the repo for the user needs no host name; sending them to the
                     host's own form needs one, so that variant waits until a host is
                     resolved rather than guessing which page to open. -->
                <UButton
                  v-if="!intoMonorepo && (github.canCreateRepos || createRepoUrl)"
                  color="neutral"
                  variant="subtle"
                  :icon="github.canCreateRepos ? 'i-lucide-plus' : 'i-lucide-external-link'"
                  :loading="creatingRepo"
                  :disabled="!repoName.trim() || !!repoNameError"
                  :title="
                    github.canCreateRepos
                      ? t('bootstrap.createRepo.titleNow')
                      : t('vcs.bootstrap.createRepoTitle', { provider: providerLabel })
                  "
                  @click="openCreateRepo"
                >
                  {{
                    github.canCreateRepos
                      ? t('bootstrap.createRepo.now')
                      : t('vcs.bootstrap.createRepoOn', { provider: providerLabel })
                  }}
                </UButton>
              </div>
              <UButton
                v-if="!intoMonorepo && manageInstallUrl && !github.canCreateRepos"
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
            <!-- The options come from the connected projection, so a repo to pick means a
                 connection exists and `providerLabel` names it rather than guessing. -->
            <UFormField
              v-if="hasRepoOptions"
              :label="t('vcs.bootstrap.archPickRepo', { provider: providerLabel })"
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
              <UButton
                color="neutral"
                variant="ghost"
                @click="
                  () => {
                    showArchForm = false
                  }
                "
              >
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
