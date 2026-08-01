<script setup lang="ts">
// The services THIS tier registers (backend/docs/adr/0031-foundational-services.md) — the raw list,
// not the merge — plus the editor that creates and patches one.
//
// The editor's shape follows the feature's contract rules rather than plain CRUD convenience:
// the `id` is what an Architect writes in its design, so it is fixed at creation and shown
// read-only afterwards; and `contracts`, when submitted, REPLACES the whole uploaded set, which
// is stated on the form because a partial edit would silently drop a document. A repo-sourced row
// is not editable here at all — its next sync would overwrite the edit — so it is labelled with
// its source instead.
import { computed, reactive, ref } from 'vue'
import type {
  ApiContractFormat,
  FoundationalService,
  FoundationalServiceOwnerKind,
  UploadApiContract,
} from '~/types/domain'
import {
  useFoundationalServices,
  useFoundationalServicesStore,
} from '~/stores/foundationalServices'
import FoundationalContractSummary from '~/components/foundational/FoundationalContractSummary.vue'

const props = defineProps<{ kind: FoundationalServiceOwnerKind; ownerId: string }>()

const catalog =
  props.kind === 'workspace'
    ? useFoundationalServicesStore()
    : useFoundationalServices(props.kind, props.ownerId)
const toast = useToast()
const { t } = useI18n()
const { confirm } = useConfirm()

// Exhaustive format→label map of literal `t(...)` keys (keeps the typed-key drift guard live).
const formatLabel = computed<Record<ApiContractFormat, string>>(() => ({
  openapi: t('foundational.format.openapi'),
  'toad-contract': t('foundational.format.toadContract'),
  'lokalise-api-contract': t('foundational.format.lokaliseApiContract'),
}))
const formatItems = computed(() =>
  (Object.keys(formatLabel.value) as ApiContractFormat[]).map((value) => ({
    value,
    label: formatLabel.value[value],
  })),
)

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

// ---- the editor ------------------------------------------------------------
/** null = closed; '' = creating; a service id = editing that row. */
const editing = ref<string | null>(null)
const saving = ref(false)
const draft = reactive({
  id: '',
  name: '',
  summary: '',
  description: '',
  capabilities: '',
  /** Left untouched ⇒ the stored set is kept; edited ⇒ the whole set is replaced. */
  contracts: [] as UploadApiContract[],
  contractsTouched: false,
})

const isCreating = computed(() => editing.value === '')

function openCreate() {
  Object.assign(draft, {
    id: '',
    name: '',
    summary: '',
    description: '',
    capabilities: '',
    contracts: [],
    contractsTouched: false,
  })
  editing.value = ''
}

function openEdit(service: FoundationalService) {
  Object.assign(draft, {
    id: service.id,
    name: service.name,
    summary: service.summary,
    description: service.description,
    capabilities: service.capabilities.join(', '),
    // Deliberately NOT prefilled from the manifest: the manifest carries no bodies, so
    // prefilling would submit empty documents over real ones. Untouched ⇒ nothing is sent.
    contracts: [],
    contractsTouched: false,
  })
  editing.value = service.id
}

function addContract() {
  draft.contracts.push({ contractId: '', format: 'openapi', title: '', body: '' })
  draft.contractsTouched = true
}

function removeContract(index: number) {
  draft.contracts.splice(index, 1)
  draft.contractsTouched = true
}

const capabilityList = computed(() =>
  draft.capabilities
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean),
)

const draftValid = computed(() => {
  if (!draft.name.trim() || !draft.summary.trim()) return false
  if (isCreating.value && !/^[a-z0-9][a-z0-9-]*$/.test(draft.id.trim())) return false
  return draft.contracts.every((c) => c.contractId.trim() && c.title.trim() && c.body.trim())
})

async function save() {
  if (!draftValid.value) return
  saving.value = true
  try {
    const contracts = draft.contractsTouched ? draft.contracts : undefined
    if (isCreating.value) {
      await catalog.create({
        id: draft.id.trim(),
        name: draft.name.trim(),
        summary: draft.summary.trim(),
        description: draft.description.trim(),
        capabilities: capabilityList.value,
        ...(contracts ? { contracts } : {}),
      })
      toast.add({ title: t('foundational.toast.created'), icon: 'i-lucide-check' })
    } else {
      await catalog.update(draft.id, {
        name: draft.name.trim(),
        summary: draft.summary.trim(),
        description: draft.description.trim(),
        capabilities: capabilityList.value,
        ...(contracts ? { contracts } : {}),
      })
      toast.add({ title: t('foundational.toast.updated'), icon: 'i-lucide-check' })
    }
    editing.value = null
  } catch (e) {
    notifyError(t('foundational.toast.saveFailed'), e)
  } finally {
    saving.value = false
  }
}

// Deleting at the WORKSPACE tier leaves a tombstone, and that tombstone also suppresses an
// account service registered under the same id — the board lands in the opt-out list without ever
// having opted out. That is the intended model (a workspace tombstone IS the suppression), but it
// is invisible at the point of the click, so the confirmation says it and names where to undo it.
// An account tier has nothing above it to shadow, so it keeps the plain wording.
const deleteBody = (service: FoundationalService) =>
  props.kind === 'workspace'
    ? t('foundational.confirmDelete.bodyWorkspace', { name: service.name })
    : t('foundational.confirmDelete.body', { name: service.name })

async function remove(service: FoundationalService) {
  const ok = await confirm({
    title: t('foundational.confirmDelete.title'),
    description: deleteBody(service),
    variant: 'destructive',
    confirmLabel: t('foundational.confirmDelete.confirm'),
    icon: 'i-lucide-trash-2',
  })
  if (!ok) return
  try {
    await catalog.remove(service.id)
    toast.add({ title: t('foundational.toast.deleted'), icon: 'i-lucide-trash-2' })
  } catch (e) {
    notifyError(t('foundational.toast.deleteFailed'), e)
  }
}
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="foundational-registry">
    <div
      v-for="s in catalog.services"
      :key="s.id"
      class="rounded-md border border-slate-800 bg-slate-900/60 p-3"
    >
      <div class="flex items-start gap-2">
        <UIcon name="i-lucide-boxes" class="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-slate-100">
            {{ s.name }}
            <code class="ms-1 text-[11px] text-slate-500">{{ s.id }}</code>
          </p>
          <p class="text-xs text-slate-400">{{ s.summary }}</p>
          <div v-if="s.capabilities.length" class="mt-1 flex flex-wrap gap-1">
            <UBadge v-for="c in s.capabilities" :key="c" size="xs" variant="subtle" color="neutral">
              {{ c }}
            </UBadge>
          </div>
          <FoundationalContractSummary :contracts="s.contracts" :format-label="formatLabel" />
          <p v-if="s.sourceId" class="mt-1 text-[11px] text-slate-500">
            {{ t('foundational.registry.fromSource', { path: s.sourcePath ?? '' }) }}
          </p>
        </div>
        <div class="flex shrink-0 gap-1">
          <UButton
            v-if="!s.sourceId"
            icon="i-lucide-pencil"
            size="xs"
            variant="ghost"
            :title="t('foundational.registry.edit')"
            @click="openEdit(s)"
          />
          <UButton
            icon="i-lucide-trash-2"
            size="xs"
            color="error"
            variant="ghost"
            :title="t('foundational.registry.delete')"
            @click="remove(s)"
          />
        </div>
      </div>
    </div>
    <p v-if="!catalog.services.length" class="text-sm text-slate-500">
      {{ t('foundational.registry.empty') }}
    </p>

    <UButton
      v-if="editing === null"
      icon="i-lucide-plus"
      size="sm"
      variant="soft"
      class="self-start"
      data-testid="foundational-add-service"
      @click="openCreate"
    >
      {{ t('foundational.registry.add') }}
    </UButton>

    <div v-else class="rounded-md border border-slate-800 p-3">
      <p class="mb-2 text-sm font-medium">
        {{
          isCreating ? t('foundational.registry.addTitle') : t('foundational.registry.editTitle')
        }}
      </p>
      <div class="flex flex-col gap-2">
        <!-- The id is what an Architect names in its design, so it is fixed once registered. -->
        <UInput
          v-if="isCreating"
          v-model="draft.id"
          :placeholder="t('foundational.registry.idPlaceholder')"
        />
        <p v-else class="text-xs text-slate-500">
          <code class="text-slate-300">{{ draft.id }}</code>
          — {{ t('foundational.registry.idFixed') }}
        </p>
        <UInput v-model="draft.name" :placeholder="t('foundational.registry.namePlaceholder')" />
        <UInput
          v-model="draft.summary"
          :placeholder="t('foundational.registry.summaryPlaceholder')"
        />
        <UTextarea
          v-model="draft.description"
          :rows="4"
          :placeholder="t('foundational.registry.descriptionPlaceholder')"
        />
        <UInput
          v-model="draft.capabilities"
          :placeholder="t('foundational.registry.capabilitiesPlaceholder')"
        />

        <div class="rounded-md border border-slate-800 p-2">
          <p class="text-xs font-medium text-slate-300">
            {{ t('foundational.registry.contractsTitle') }}
          </p>
          <p class="mb-2 text-[11px] text-slate-500">
            {{
              draft.contractsTouched
                ? t('foundational.registry.contractsReplace')
                : t('foundational.registry.contractsKeep')
            }}
          </p>
          <div v-for="(c, i) in draft.contracts" :key="i" class="mb-2 flex flex-col gap-1">
            <div class="flex gap-2">
              <UInput
                v-model="c.contractId"
                :placeholder="t('foundational.registry.contractIdPlaceholder')"
                class="flex-1"
              />
              <USelect v-model="c.format" :items="formatItems" class="w-56" />
              <UButton
                icon="i-lucide-x"
                size="xs"
                color="error"
                variant="ghost"
                :title="t('foundational.registry.removeContract')"
                @click="removeContract(i)"
              />
            </div>
            <UInput
              v-model="c.title"
              :placeholder="t('foundational.registry.contractTitlePlaceholder')"
            />
            <UTextarea
              v-model="c.body"
              :rows="6"
              class="font-mono"
              :placeholder="t('foundational.registry.contractBodyPlaceholder')"
            />
          </div>
          <UButton icon="i-lucide-plus" size="xs" variant="ghost" @click="addContract">
            {{ t('foundational.registry.addContract') }}
          </UButton>
        </div>

        <div class="flex gap-2">
          <UButton
            size="sm"
            :disabled="!draftValid"
            :loading="saving"
            data-testid="foundational-save-service"
            @click="save"
          >
            {{ t('foundational.registry.save') }}
          </UButton>
          <UButton size="sm" variant="ghost" @click="editing = null">
            {{ t('foundational.registry.cancel') }}
          </UButton>
        </div>
      </div>
    </div>
  </div>
</template>
