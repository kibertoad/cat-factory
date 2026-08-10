<script setup lang="ts">
// Workspace settings: the values for the CUSTOM metadata fields a deployment declares in code
// (the `workspaceMetadataFields` slot — see `modular/workspace-metadata.ts`). The fields come
// from the registry; the values are per workspace and land in the settings row's `metadata`
// bag, where external-tool URL resolvers read them ("open the map editor on this board's game").
//
// A deployment that declares NOTHING never gets here — the panel's tab exists only where fields
// are declared, so an unwired capability is invisible rather than an empty tab everywhere. The
// empty state below is therefore the loud one: fields WERE declared and every one was rejected
// (a malformed key), which must not look like a deployment that declared none.
import { reactive, watch } from 'vue'
import { useReactiveSlots } from '@modular-vue/runtime'
import {
  metadataDraftFrom,
  metadataPatchFrom,
  resolveMetadataFields,
} from '~/modular/workspace-metadata'
import type { WorkspaceMetadataFieldDefinition } from '~/modular/workspace-metadata'
import type { AppSlots } from '~/modular/slots'

const { t } = useI18n()
const slots = useReactiveSlots<AppSlots>()
const store = useWorkspaceSettingsStore()
const toast = useToast()
const { present } = usePipelineErrorToast()

/**
 * The fields to render. A malformed key is dropped (the store would refuse every save) and
 * NAMED in the console rather than swallowed — the deployment author is the only person who
 * can fix it, and a silently missing field looks exactly like one nobody declared.
 */
const fields = computed<WorkspaceMetadataFieldDefinition[]>(() => {
  const { fields: valid, rejected } = resolveMetadataFields(
    (slots.value.workspaceMetadataFields ?? []) as WorkspaceMetadataFieldDefinition[],
  )
  if (import.meta.dev && rejected.length > 0) {
    console.warn(
      '[cat-factory] workspace metadata fields dropped (invalid or duplicate key):',
      rejected.map((f) => f.key),
    )
  }
  return valid
})

// Local editable copy, re-seeded whenever the stored settings are replaced (the store always
// reassigns the ref, so tracking the object reference is enough).
const draft = reactive<Record<string, string>>({})
watch(
  [() => store.settings, fields],
  () => {
    const next = metadataDraftFrom(fields.value, store.settings.metadata)
    for (const key of Object.keys(draft)) delete draft[key]
    Object.assign(draft, next)
  },
  { immediate: true },
)

const saving = ref(false)

async function save() {
  saving.value = true
  try {
    // `metadataPatchFrom` carries any stored key this build does not render back into the
    // patch: the update REPLACES the bag, so a value written under a retired field would
    // otherwise be deleted by an unrelated save.
    await store.update({
      metadata: metadataPatchFrom(fields.value, draft, store.settings.metadata),
    })
    toast.add({
      title: t('settings.workspaceSettings.toast.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'settings.workspaceSettings.toast.saveFailed')
  } finally {
    saving.value = false
  }
}

/** A `select` field's items, with an explicit "not set" choice so a value can be cleared. */
function selectItems(field: WorkspaceMetadataFieldDefinition) {
  return [
    { label: t('settings.workspaceSettings.metadata.unset'), value: '' },
    ...(field.options ?? []).map((o) => ({ label: o.label, value: o.value })),
  ]
}
</script>

<template>
  <div class="space-y-6" data-testid="workspace-metadata-settings">
    <section class="space-y-2">
      <h3 class="text-sm font-semibold text-slate-200">
        {{ t('settings.workspaceSettings.metadata.heading') }}
      </h3>
      <p class="text-[11px] text-slate-400">
        {{ t('settings.workspaceSettings.metadata.body') }}
      </p>
    </section>

    <p v-if="fields.length === 0" class="text-[11px] text-slate-500">
      {{ t('settings.workspaceSettings.metadata.empty') }}
    </p>

    <template v-else>
      <div class="space-y-4">
        <label v-for="field in fields" :key="field.key" class="block">
          <!-- Field labels are deployment DATA, rendered verbatim (see the module docs). -->
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ field.label }}
          </span>
          <USelect
            v-if="field.type === 'select'"
            v-model="draft[field.key]"
            :items="selectItems(field)"
            size="sm"
            :data-testid="`workspace-metadata-${field.key}`"
          />
          <UInput
            v-else
            v-model="draft[field.key]"
            :type="field.type === 'number' ? 'number' : 'text'"
            :placeholder="field.placeholder"
            size="sm"
            :data-testid="`workspace-metadata-${field.key}`"
          />
          <span v-if="field.description" class="mt-1 block text-[11px] text-slate-500">
            {{ field.description }}
          </span>
        </label>
      </div>

      <div class="flex justify-end">
        <UButton
          color="primary"
          size="sm"
          icon="i-lucide-save"
          :loading="saving"
          data-testid="workspace-metadata-save"
          @click="save"
        >
          {{ t('common.save') }}
        </UButton>
      </div>
    </template>
  </div>
</template>
