<script setup lang="ts">
// Generic, descriptor-driven form renderer: ONE component behind every surface where the BACKEND
// declares the fields and the SPA only collects them. Two use it today, and they used to carry
// near-duplicate renderers of the same vocabulary:
//
//   - an initiative PRESET's create-time form (`CreateInitiativeModal`)
//   - a reusable OPERATION's per-case brief on a custom task type (`AddTaskModal`)
//
// It extends `ProviderConnectionTab.vue`'s flat-field pattern with the shapes a declared form needs:
// `checkbox-group` (multi-select whose value is `string[]`), `path` (a repo-relative dir with inline
// safety validation), and single-condition `showWhen` visibility. Labels/help/option captions are
// backend-supplied English (the `describeConfig` convention); only the chrome is i18n.
//
// The model is the typed `DescriptorFieldValues` map (scalars stay strings, `number` a number,
// `checkbox` a boolean, `checkbox-group` a `string[]`), so it round-trips the wire contract and the
// shared `validateDescriptorFields` / `sanitizeDescriptorFields` rules unchanged.
import { computed } from 'vue'
import { isDescriptorFieldVisible, isSafeRepoDirPath } from '@cat-factory/contracts'
import type { DescriptorField, DescriptorFieldValue, DescriptorFieldValues } from '~/types/domain'

const props = withDefaults(
  defineProps<{
    /** The fields to render, in declaration order (a preset's `fields`, a task type's `fields`). */
    fields: readonly DescriptorField[]
    /**
     * Prefix for each field's `data-testid`, so a spec targets a field by the SURFACE it is on
     * (`custom-field-entity`) rather than by which component happens to render it.
     */
    testidPrefix?: string
  }>(),
  { testidPrefix: 'descriptor-field' },
)
const model = defineModel<DescriptorFieldValues>({ required: true })
const { t } = useI18n()

// Only fields whose `showWhen` holds against the current values are shown; a hidden field's stale
// value is kept in the model (so re-showing restores it) but the server + client both drop it at
// sanitize/validate time, so it can never freeze an unvalidated value.
const visibleFields = computed(() =>
  props.fields.filter((f) => isDescriptorFieldVisible(f, model.value)),
)

/**
 * An "empty" value that must stay ABSENT from the model rather than freeze on the entity: an
 * unchecked (`false`) checkbox, a blank string, or an empty multi-select. A numeric `0` is a real
 * value and is kept (strict `=== false`/`=== ''` never match it).
 */
function isEmptyValue(value: DescriptorFieldValue): boolean {
  return value === false || value === '' || (Array.isArray(value) && value.length === 0)
}

/**
 * Immutably set one field's value on the model, DROPPING empty values so a cleared field never
 * freezes an empty `''`/`[]`/`false` (mirrors `ProviderConnectionTab`'s delete-when-blank and what
 * the shared `validate`/`sanitize` treat as unset: an unchecked box / blank field stays absent).
 */
function set(key: string, value: DescriptorFieldValue | undefined): void {
  const next = { ...model.value }
  if (value === undefined || isEmptyValue(value)) delete next[key]
  else next[key] = value
  model.value = next
}

/**
 * Set a checkbox value. A checkbox whose descriptor default is ON (`default: 'true'`) must be able
 * to persist an explicit `false`: {@link set} otherwise drops a `false` (an off box "stays unset"),
 * which for a default-ON field is indistinguishable from "untouched, still on", so a consumer that
 * reads the opt-out as `humanReview !== false` (e.g. `seedMigrationPlan`) could never observe the
 * unchecked state and the toggle would be dead. A default-OFF checkbox keeps the drop-when-false
 * behaviour (absent === unchecked), so it never freezes a redundant `false`.
 */
function setCheckbox(field: DescriptorField, checked: boolean): void {
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
function pathInvalid(field: DescriptorField): boolean {
  if (field.type !== 'path') return false
  const value = stringValue(field.key)
  return value.trim().length > 0 && !isSafeRepoDirPath(value)
}

function selectItems(field: DescriptorField) {
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
      :error="pathInvalid(field) ? t('common.pathInvalid') : undefined"
      :data-testid="`${testidPrefix}-${field.key}`"
    >
      <!-- checkbox-group: a vertical list of toggles whose value is the checked option set. -->
      <div v-if="field.type === 'checkbox-group'" class="space-y-1.5">
        <UCheckbox
          v-for="opt in field.options ?? []"
          :key="opt.value"
          :model-value="groupValue(field.key).includes(opt.value)"
          :label="opt.label"
          :data-testid="`${testidPrefix}-${field.key}-${opt.value}`"
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
        :maxlength="field.maxLength"
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
        :maxlength="field.maxLength"
        :placeholder="field.placeholder"
        @update:model-value="(v: string) => set(field.key, v)"
      />
    </UFormField>
  </div>
</template>
