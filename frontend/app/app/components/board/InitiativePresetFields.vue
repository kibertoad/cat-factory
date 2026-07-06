<script setup lang="ts">
// Generic, descriptor-driven renderer for an initiative preset's create-time FORM. Extends the
// `ProviderConnectionTab.vue` flat-field pattern with the three shapes a preset form adds:
// `checkbox-group` (multi-select → `string[]`), `path` (a repo-relative dir with inline
// safety validation), and single-condition `showWhen` visibility. Every preset renders through
// THIS component with zero per-preset frontend code — the backend descriptor supplies the fields
// (labels/help/options are backend-supplied English, per the `describeConfig` convention). The
// model is the typed `InitiativePresetInputs` map (scalars stay strings, `number` a number,
// `checkbox` a boolean, `checkbox-group` a `string[]`) so it round-trips the wire contract and the
// shared `validateInitiativePresetInputs` unchanged.
import { computed } from 'vue'
import { isPresetFieldVisible, isSafeRepoDirPath } from '@cat-factory/contracts'
import type {
  InitiativePresetDescriptor,
  InitiativePresetField,
  InitiativePresetInputs,
  InitiativePresetInputValue,
} from '~/types/domain'

const props = defineProps<{ descriptor: InitiativePresetDescriptor }>()
const model = defineModel<InitiativePresetInputs>({ required: true })
const { t } = useI18n()

// Only fields whose `showWhen` holds against the current values are shown; a hidden field's stale
// value is kept in the model (so re-showing restores it) but the server + client both drop it at
// sanitize/validate time, so it can never freeze an unvalidated value.
const visibleFields = computed(() =>
  props.descriptor.fields.filter((f) => isPresetFieldVisible(f, model.value)),
)

/**
 * An "empty" value that must stay ABSENT from the model rather than freeze on the entity: an
 * unchecked (`false`) checkbox, a blank string, or an empty multi-select. A numeric `0` is a real
 * value and is kept (strict `=== false`/`=== ''` never match it).
 */
function isEmptyValue(value: InitiativePresetInputValue): boolean {
  return value === false || value === '' || (Array.isArray(value) && value.length === 0)
}

/**
 * Immutably set one field's value on the model, DROPPING empty values so a cleared field never
 * freezes an empty `''`/`[]`/`false` (mirrors `ProviderConnectionTab`'s delete-when-blank and what
 * the shared `validate`/`sanitize` treat as unset — an unchecked box / blank field stays absent).
 */
function set(key: string, value: InitiativePresetInputValue | undefined): void {
  const next = { ...model.value }
  if (value === undefined || isEmptyValue(value)) delete next[key]
  else next[key] = value
  model.value = next
}

/**
 * Set a checkbox value. A checkbox whose descriptor default is ON (`default: 'true'`) must be able
 * to persist an explicit `false`: {@link set} otherwise drops a `false` (an off box "stays unset"),
 * which for a default-ON field is indistinguishable from "untouched, still on" — so a consumer that
 * reads the opt-out as `humanReview !== false` (e.g. `seedMigrationPlan`) could never observe the
 * unchecked state and the toggle would be dead. A default-OFF checkbox keeps the drop-when-false
 * behaviour (absent === unchecked), so it never freezes a redundant `false`.
 */
function setCheckbox(field: InitiativePresetField, checked: boolean): void {
  if (!checked && field.default === 'true') {
    model.value = { ...model.value, [field.key]: false }
    return
  }
  set(field.key, checked)
}

function stringValue(key: string): string {
  const v = model.value[key]
  return typeof v === 'string' ? v : ''
}
function boolValue(key: string): boolean {
  return model.value[key] === true
}
function numberStr(key: string): string {
  const v = model.value[key]
  return typeof v === 'number' ? String(v) : ''
}
function groupValue(key: string): string[] {
  const v = model.value[key]
  return Array.isArray(v) ? v : []
}

function toggleGroup(key: string, option: string, checked: boolean): void {
  const current = groupValue(key)
  set(key, checked ? [...new Set([...current, option])] : current.filter((o) => o !== option))
}

/** A `path` field is flagged only when non-empty AND unsafe (empty is handled by `required`). */
function pathInvalid(field: InitiativePresetField): boolean {
  if (field.type !== 'path') return false
  const value = stringValue(field.key)
  return value.trim().length > 0 && !isSafeRepoDirPath(value)
}

function selectItems(field: InitiativePresetField) {
  return (field.options ?? []).map((o) => ({ label: o.label, value: o.value }))
}
</script>

<template>
  <div v-if="visibleFields.length" class="space-y-4">
    <UFormField
      v-for="field in visibleFields"
      :key="field.key"
      :label="field.label"
      :help="field.help"
      :required="field.required"
      :error="pathInvalid(field) ? t('initiative.create.pathInvalid') : undefined"
      :data-testid="`initiative-preset-field-${field.key}`"
    >
      <!-- checkbox-group: a vertical list of toggles whose value is the checked option set. -->
      <div v-if="field.type === 'checkbox-group'" class="space-y-1.5">
        <UCheckbox
          v-for="opt in field.options ?? []"
          :key="opt.value"
          :model-value="groupValue(field.key).includes(opt.value)"
          :label="opt.label"
          @update:model-value="
            (v: boolean | 'indeterminate') => toggleGroup(field.key, opt.value, v === true)
          "
        />
      </div>

      <USelect
        v-else-if="field.type === 'select'"
        :model-value="stringValue(field.key)"
        :items="selectItems(field)"
        class="w-full"
        :placeholder="field.placeholder"
        @update:model-value="(v: string) => set(field.key, v)"
      />

      <USwitch
        v-else-if="field.type === 'checkbox'"
        :model-value="boolValue(field.key)"
        @update:model-value="(v: boolean) => setCheckbox(field, v)"
      />

      <UTextarea
        v-else-if="field.type === 'textarea'"
        :model-value="stringValue(field.key)"
        :rows="3"
        autoresize
        class="w-full"
        :placeholder="field.placeholder"
        @update:model-value="(v: string) => set(field.key, v)"
      />

      <UInput
        v-else-if="field.type === 'number'"
        :model-value="numberStr(field.key)"
        type="number"
        class="w-full font-mono"
        :placeholder="field.placeholder"
        @update:model-value="(v: string) => set(field.key, v === '' ? undefined : Number(v))"
      />

      <!-- path + text/password (the untyped default): a single-line input. `path`s stay mono. -->
      <UInput
        v-else
        :model-value="stringValue(field.key)"
        :type="field.type === 'password' ? 'password' : 'text'"
        class="w-full"
        :class="{ 'font-mono': field.type === 'path' }"
        :placeholder="field.placeholder"
        @update:model-value="(v: string) => set(field.key, v)"
      />
    </UFormField>
  </div>
</template>
