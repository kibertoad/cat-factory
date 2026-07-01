<script setup lang="ts">
// The custom-manifest-type catalog editor: lists the open set of `custom` provision types —
// the read-only programmatically-REGISTERED ones (from code providers) plus the WORKSPACE-
// defined ones a user can add/edit/remove here. A service pins one of these (its `manifestId`)
// and a `remote-custom` handler declares which it accepts. Writes the workspace entries via the
// infraConfig store (`PUT|DELETE /environments/custom-types/:manifestId`).
import { computed, reactive, ref } from 'vue'
import type { CustomManifestType } from '@cat-factory/contracts'

const { t } = useI18n()
const infra = useInfraConfigStore()
const toast = useToast()

// A draft for the add/edit form. `manifestId` is locked on edit (it's the PK).
const draft = reactive({
  manifestId: '',
  label: '',
  acceptsInputHint: '',
  description: '',
  defaultManifestPath: '',
  fixerPrompt: '',
})
const editing = ref(false)
const busy = ref(false)

const manifestIdValid = computed(() => /^[a-z0-9][a-z0-9-]*$/.test(draft.manifestId.trim()))
const canSave = computed(
  () => (editing.value || manifestIdValid.value) && !!draft.label.trim() && !busy.value,
)

function startAdd() {
  Object.assign(draft, {
    manifestId: '',
    label: '',
    acceptsInputHint: '',
    description: '',
    defaultManifestPath: '',
    fixerPrompt: '',
  })
  editing.value = false
}

function startEdit(type: CustomManifestType) {
  Object.assign(draft, {
    manifestId: type.manifestId,
    label: type.label,
    acceptsInputHint: type.acceptsInputHint ?? '',
    description: type.description ?? '',
    defaultManifestPath: type.defaultManifestPath ?? '',
    fixerPrompt: type.fixerPrompt ?? '',
  })
  editing.value = true
}

async function save() {
  if (!canSave.value) return
  busy.value = true
  try {
    await infra.upsertCustomType(draft.manifestId.trim(), {
      label: draft.label.trim(),
      ...(draft.acceptsInputHint.trim() ? { acceptsInputHint: draft.acceptsInputHint.trim() } : {}),
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      ...(draft.defaultManifestPath.trim()
        ? { defaultManifestPath: draft.defaultManifestPath.trim() }
        : {}),
      ...(draft.fixerPrompt.trim() ? { fixerPrompt: draft.fixerPrompt.trim() } : {}),
    })
    startAdd()
  } catch (e) {
    toast.add({
      title: t('settings.infrastructure.customType.saveFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}

async function remove(type: CustomManifestType) {
  busy.value = true
  try {
    await infra.removeCustomType(type.manifestId)
    if (editing.value && draft.manifestId === type.manifestId) startAdd()
  } catch (e) {
    toast.add({
      title: t('settings.infrastructure.customType.removeFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
    <div>
      <h3 class="text-sm font-semibold text-slate-200">
        {{ t('settings.infrastructure.customType.title') }}
      </h3>
      <p class="text-[11px] text-slate-500">{{ t('settings.infrastructure.customType.hint') }}</p>
    </div>

    <!-- The catalog: registered (read-only) + workspace (editable). -->
    <ul v-if="infra.customTypes.length" class="space-y-1.5">
      <li
        v-for="type in infra.customTypes"
        :key="type.manifestId"
        class="flex items-start justify-between gap-2 rounded-md border border-slate-800 bg-slate-900/50 px-2.5 py-1.5"
      >
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="truncate text-[13px] text-slate-200">{{ type.label }}</span>
            <UBadge
              :color="type.source === 'workspace' ? 'primary' : 'neutral'"
              variant="subtle"
              size="sm"
            >
              {{ t(`settings.infrastructure.customType.source.${type.source}`) }}
            </UBadge>
          </div>
          <code class="text-[11px] text-slate-500">{{ type.manifestId }}</code>
          <p v-if="type.description" class="text-[11px] text-slate-400">{{ type.description }}</p>
        </div>
        <div v-if="type.source === 'workspace'" class="flex shrink-0 items-center gap-0.5">
          <UButton
            icon="i-lucide-pencil"
            color="neutral"
            variant="ghost"
            size="xs"
            :disabled="busy"
            @click="startEdit(type)"
          />
          <UButton
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            size="xs"
            :disabled="busy"
            @click="remove(type)"
          />
        </div>
      </li>
    </ul>
    <p v-else class="text-[11px] text-slate-500">
      {{ t('settings.infrastructure.customType.empty') }}
    </p>

    <!-- Add / edit a workspace-defined type. -->
    <div class="space-y-2 border-t border-slate-800 pt-3">
      <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{
          editing
            ? t('settings.infrastructure.customType.editTitle', { id: draft.manifestId })
            : t('settings.infrastructure.customType.addTitle')
        }}
      </p>
      <UFormField
        v-if="!editing"
        :label="t('settings.infrastructure.customType.manifestId')"
        :help="t('settings.infrastructure.customType.manifestIdHelp')"
      >
        <UInput v-model="draft.manifestId" class="font-mono" placeholder="my-kargo-template" />
      </UFormField>
      <UFormField :label="t('settings.infrastructure.customType.label')">
        <UInput v-model="draft.label" />
      </UFormField>
      <UFormField
        :label="t('settings.infrastructure.customType.acceptsInputHint')"
        :help="t('settings.infrastructure.customType.acceptsInputHintHelp')"
      >
        <UInput v-model="draft.acceptsInputHint" />
      </UFormField>
      <UFormField :label="t('settings.infrastructure.customType.description')">
        <UTextarea v-model="draft.description" :rows="2" />
      </UFormField>
      <UFormField
        :label="t('settings.infrastructure.customType.defaultManifestPath')"
        :help="t('settings.infrastructure.customType.defaultManifestPathHelp')"
      >
        <UInput
          v-model="draft.defaultManifestPath"
          class="font-mono"
          placeholder="deploy/preview.yaml"
        />
      </UFormField>
      <UFormField
        :label="t('settings.infrastructure.customType.fixerPrompt')"
        :help="t('settings.infrastructure.customType.fixerPromptHelp')"
      >
        <UTextarea v-model="draft.fixerPrompt" :rows="3" />
      </UFormField>
      <div class="flex justify-end gap-2">
        <UButton v-if="editing" color="neutral" variant="ghost" size="sm" @click="startAdd">
          {{ t('common.cancel') }}
        </UButton>
        <UButton color="primary" size="sm" :loading="busy" :disabled="!canSave" @click="save">
          {{ editing ? t('common.save') : t('settings.infrastructure.customType.add') }}
        </UButton>
      </div>
    </div>
  </section>
</template>
