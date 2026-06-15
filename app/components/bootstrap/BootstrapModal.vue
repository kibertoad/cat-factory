<script setup lang="ts">
// Repo bootstrap: manage the reference architecture list and launch a "bootstrap
// repo" run. A run creates a new repository from the chosen reference architecture
// and has a bootstrapper agent adapt it (in a sandbox container) per the extra
// instructions — so the modal pairs a launch form with the managed base list.
import type { BootstrapStatus, ReferenceArchitecture } from '~/types/domain'

const ui = useUiStore()
const bootstrap = useBootstrapStore()
const toast = useToast()

const open = computed({
  get: () => ui.bootstrapOpen,
  set: (v: boolean) => {
    if (!v) ui.closeBootstrap()
  },
})

// Load the workspace's reference architectures + recent jobs when opened.
watch(open, (isOpen) => {
  if (isOpen) void bootstrap.load()
})

// ---- launch form -----------------------------------------------------------
const selectedArchId = ref<string | null>(null)
const repoName = ref('')
const description = ref('')
const isPrivate = ref(true)
const instructions = ref('')
const launching = ref(false)

const selectedArch = computed(() =>
  bootstrap.architectures.find((a) => a.id === selectedArchId.value),
)

// Keep a sensible default selection as the list loads/changes.
watch(
  () => bootstrap.architectures,
  (list) => {
    if (!selectedArchId.value && list.length) selectedArchId.value = list[0]!.id
  },
  { immediate: true },
)

const archMenu = computed(() => [
  bootstrap.architectures.map((a) => ({
    label: `${a.name} · ${a.repoOwner}/${a.repoName}`,
    icon: 'i-lucide-package',
    onSelect: () => (selectedArchId.value = a.id),
  })),
])

const canLaunch = computed(() => !!selectedArchId.value && repoName.value.trim().length > 0)

async function launch() {
  if (!canLaunch.value) return
  launching.value = true
  try {
    const job = await bootstrap.bootstrap({
      referenceArchitectureId: selectedArchId.value!,
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

function startCreate() {
  archForm.value = blankForm()
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
    if (selectedArchId.value === a.id) selectedArchId.value = null
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
          Create a brand-new repository from a reference architecture. A bootstrapper agent runs in
          a sandbox container to adapt the base to your new service following the instructions.
        </p>

        <!-- launch -->
        <section class="space-y-3">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            New repository
          </h3>

          <div v-if="!bootstrap.hasArchitectures" class="text-sm text-slate-400">
            Add a reference architecture below to bootstrap from.
          </div>

          <template v-else>
            <UFormField label="Reference architecture">
              <UDropdownMenu :items="archMenu" :content="{ align: 'start' }">
                <UButton
                  color="neutral"
                  variant="subtle"
                  trailing-icon="i-lucide-chevron-down"
                  class="w-full justify-between"
                >
                  <span class="truncate">
                    {{
                      selectedArch
                        ? `${selectedArch.name} · ${selectedArch.repoOwner}/${selectedArch.repoName}`
                        : 'Choose a reference architecture'
                    }}
                  </span>
                </UButton>
              </UDropdownMenu>
            </UFormField>

            <UFormField label="New repo name">
              <UInput v-model="repoName" placeholder="payments-service" class="w-full" />
            </UFormField>
            <UFormField label="Description">
              <UInput v-model="description" placeholder="Optional one-liner" class="w-full" />
            </UFormField>
            <UFormField label="Extra instructions for the bootstrapper">
              <UTextarea
                v-model="instructions"
                :rows="3"
                placeholder="e.g. rename the package to payments, drop the example queue worker"
                class="w-full"
              />
            </UFormField>
            <div class="flex items-center gap-2">
              <USwitch v-model="isPrivate" />
              <span class="text-sm text-slate-300">Private repository</span>
            </div>

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
          </template>
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
                from {{ job.referenceArchitectureName }}
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
            <UFormField label="Name">
              <UInput v-model="archForm.name" placeholder="Service Template" class="w-full" />
            </UFormField>
            <div class="grid grid-cols-2 gap-2">
              <UFormField label="Repo owner">
                <UInput v-model="archForm.repoOwner" placeholder="acme" class="w-full" />
              </UFormField>
              <UFormField label="Repo name">
                <UInput v-model="archForm.repoName" placeholder="service-template" class="w-full" />
              </UFormField>
            </div>
            <UFormField label="Description">
              <UInput v-model="archForm.description" class="w-full" />
            </UFormField>
            <UFormField label="Default bootstrapper instructions">
              <UTextarea v-model="archForm.defaultInstructions" :rows="2" class="w-full" />
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
