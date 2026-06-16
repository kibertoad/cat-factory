<script setup lang="ts">
// Repo bootstrap: launch a "bootstrap repo" run and manage the reference
// architecture list. A run creates a new repository and has a bootstrapper agent
// adapt it (in a sandbox container) — either by cloning a chosen reference
// architecture, or from scratch following a freeform prompt. The modal pairs the
// launch form with the managed base list.
import type { BootstrapStatus, ReferenceArchitecture } from '~/types/domain'

const ui = useUiStore()
const bootstrap = useBootstrapStore()
const github = useGitHubStore()
const toast = useToast()

const open = computed({
  get: () => ui.bootstrapOpen,
  set: (v: boolean) => {
    if (!v) ui.closeBootstrap()
  },
})

// Load the workspace's reference architectures + recent jobs, plus (best-effort)
// the GitHub repos the user can access so the base form can pick from them.
watch(open, (isOpen) => {
  if (isOpen) {
    void bootstrap.load()
    void loadGitHubRepos()
  }
})

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
const modeItems = [
  {
    label: 'From a reference architecture',
    value: 'reference' as const,
    description: 'Clone a managed base repo and adapt it to the new service.',
  },
  {
    label: 'From scratch',
    value: 'scratch' as const,
    description: 'Scaffold a brand-new repo from a freeform prompt — no base needed.',
  },
]

const selectedArchId = ref<string | undefined>(undefined)
const repoName = ref('')
const description = ref('')
const isPrivate = ref(true)
const instructions = ref('')
const launching = ref(false)

const usingReference = computed(() => mode.value === 'reference')

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

const canLaunch = computed(() => {
  if (!repoName.value.trim()) return false
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
    })
    if (job.status === 'succeeded') {
      toast.add({
        title: 'Repository bootstrapped',
        description: job.repoUrl ?? undefined,
        icon: 'i-lucide-check',
        color: 'success',
      })
      repoName.value = ''
      description.value = ''
      instructions.value = ''
    } else {
      toast.add({
        title: 'Bootstrap failed',
        description: job.error ?? 'The bootstrapper reported a failure.',
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
  } catch (e) {
    toast.add({
      title: 'Could not bootstrap',
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
      title: 'Could not save reference architecture',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    savingArch.value = false
  }
}

async function removeArch(a: ReferenceArchitecture) {
  try {
    await bootstrap.deleteArchitecture(a.id)
    if (selectedArchId.value === a.id) selectedArchId.value = undefined
  } catch (e) {
    toast.add({
      title: 'Could not delete',
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
</script>

<template>
  <UModal v-model:open="open" title="Bootstrap a repository" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="space-y-6">
        <p class="text-sm text-slate-400">
          Create a brand-new repository and let a bootstrapper agent set it up in a sandbox
          container — either by adapting one of your reference architectures, or from scratch
          following a freeform prompt.
        </p>

        <!-- launch -->
        <section class="space-y-4">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            New repository
          </h3>

          <UFormField label="How should we start?" required>
            <URadioGroup v-model="mode" :items="modeItems" />
          </UFormField>

          <template v-if="usingReference">
            <UFormField
              label="Reference architecture"
              description="The managed base repo to clone and adapt."
              required
            >
              <div v-if="!bootstrap.hasArchitectures" class="text-sm text-slate-400">
                No reference architectures yet — add one below, or switch to “From scratch”.
              </div>
              <USelect
                v-else
                v-model="selectedArchId"
                :items="archOptions"
                placeholder="Choose a reference architecture"
                class="w-full"
              />
            </UFormField>
          </template>

          <UFormField
            label="New repository name"
            description="The repo is created under your connected GitHub account/org."
            required
          >
            <UInput v-model="repoName" placeholder="payments-service" class="w-full" />
          </UFormField>

          <UFormField label="Description" description="Optional one-line summary for the repo.">
            <UInput
              v-model="description"
              placeholder="Handles payment intents and refunds"
              class="w-full"
            />
          </UFormField>

          <UFormField
            :label="
              usingReference
                ? 'Extra instructions for the bootstrapper'
                : 'What should the bootstrapper build?'
            "
            :description="
              usingReference
                ? 'Optional — appended to the reference architecture’s default instructions.'
                : 'Describe the new service: stack, structure, and what it should do.'
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

          <UFormField label="Visibility">
            <div class="flex items-center gap-2">
              <USwitch v-model="isPrivate" />
              <span class="text-sm text-slate-300">Private repository</span>
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
              Bootstrap repo
            </UButton>
          </div>
        </section>

        <!-- recent jobs -->
        <section v-if="bootstrap.jobs.length" class="space-y-2">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Recent runs
          </h3>
          <div
            v-for="job in bootstrap.jobs.slice(0, 5)"
            :key="job.id"
            class="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm"
          >
            <div class="min-w-0">
              <div class="truncate text-slate-200">{{ job.repoName }}</div>
              <div class="truncate text-[11px] text-slate-500">
                {{
                  job.referenceArchitectureName
                    ? `from ${job.referenceArchitectureName}`
                    : 'from scratch'
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
                Open
              </ULink>
              <UBadge :color="statusColor[job.status]" variant="subtle" size="sm">
                {{ job.status }}
              </UBadge>
            </div>
          </div>
        </section>

        <USeparator />

        <!-- reference architecture management -->
        <section class="space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Reference architectures
            </h3>
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-plus"
              @click="startCreate"
            >
              Add
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
              label="Pick an existing GitHub repo"
              description="Choose a repo you can access to fill in its owner and name, or enter them manually below."
            >
              <USelect
                v-model="archRepoSlug"
                :items="repoOptions"
                placeholder="owner/name"
                class="w-full"
              />
            </UFormField>

            <UFormField label="Name" description="A friendly label for this base." required>
              <UInput v-model="archForm.name" placeholder="Service Template" class="w-full" />
            </UFormField>
            <div class="grid grid-cols-2 gap-2">
              <UFormField label="Repo owner" required>
                <UInput v-model="archForm.repoOwner" placeholder="acme" class="w-full" />
              </UFormField>
              <UFormField label="Repo name" required>
                <UInput v-model="archForm.repoName" placeholder="service-template" class="w-full" />
              </UFormField>
            </div>
            <UFormField label="Description">
              <UInput
                v-model="archForm.description"
                placeholder="Optional summary of this base"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Default bootstrapper instructions"
              description="Prepended to the per-run instructions whenever this base is used."
            >
              <UTextarea
                v-model="archForm.defaultInstructions"
                :rows="2"
                placeholder="e.g. keep the structure; rename packages to match the new service"
                class="w-full"
              />
            </UFormField>
            <div class="flex justify-end gap-2">
              <UButton color="neutral" variant="ghost" @click="showArchForm = false">
                Cancel
              </UButton>
              <UButton
                color="primary"
                :loading="savingArch"
                :disabled="!canSaveArch"
                @click="saveArch"
              >
                {{ archForm.id ? 'Save' : 'Add' }}
              </UButton>
            </div>
          </div>
        </section>
      </div>
    </template>
  </UModal>
</template>
