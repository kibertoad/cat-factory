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
// safety validation), single-condition `showWhen` visibility, and `section` grouping captions.
// Labels/help/option/section captions are backend-supplied English (the `describeConfig`
// convention); only the chrome is i18n.
//
// The model is the typed `DescriptorFieldValues` map (scalars stay strings, `number` a number,
// `checkbox` a boolean, `checkbox-group` a `string[]`), so it round-trips the wire contract and the
// shared `validateDescriptorFields` / `sanitizeDescriptorFields` rules unchanged.
import { computed } from 'vue'
import { isSafeRepoDirPath } from '@cat-factory/contracts'
import type { DescriptorField, DescriptorFieldValue, DescriptorFieldValues } from '~/types/domain'
import {
  descriptorFormRows,
  descriptorGroupValue,
  setDescriptorCheckbox,
  setDescriptorValue,
  toggleDescriptorGroupValue,
} from '~/utils/descriptorFields'

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

// The fields to render, each carrying the section caption that opens its run. Only fields whose
// `showWhen` holds against the current values are shown; a hidden field's stale value is kept in the
// model (so re-showing restores it) but the server + client both drop it at sanitize/validate time,
// so it can never freeze an unvalidated value.
//
// The grouping underneath is the shared `descriptorFieldSections`, so a caption spans exactly what
// one function says it spans, which is the same statement the boot check refuses a declaration
// against. A form declaring no section is one uncaptioned run, i.e. byte-for-byte the flat column
// this component always rendered.
//
// The rows are FLAT, and the template keeps them siblings keyed by `field.key`, because run
// membership shifts as `showWhen` reveals fields while a field's identity does not: see
// `descriptorFormRows` for why a per-run wrapper would remount the input being typed into.
const rows = computed(() => descriptorFormRows(props.fields, model.value))

// The value-mutation rules live in `utils/descriptorFields.ts` as pure functions over the bag (what
// an edit does to it, including the drop-when-empty rule that keeps an unset answer from freezing),
// so they are unit-tested without mounting this component. Here they are only bound to the model.
function set(key: string, value: DescriptorFieldValue | undefined): void {
  model.value = setDescriptorValue(model.value, key, value)
}

function setCheckbox(field: DescriptorField, checked: boolean): void {
  model.value = setDescriptorCheckbox(model.value, field, checked)
}

function toggleGroup(key: string, option: string, checked: boolean): void {
  model.value = toggleDescriptorGroupValue(model.value, key, option, checked)
}

function groupValue(key: string): string[] {
  return descriptorGroupValue(model.value, key)
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
  <div v-if="rows.length" class="space-y-4">
    <!-- One keyed fragment per FIELD, never per run: a run's caption rides the field that opens it,
         so revealing a field re-captions rows in place instead of re-parenting the inputs (which
         Vue can only do by remounting them, destroying the one being typed into). -->
    <template v-for="{ field, caption, startsGroup } in rows" :key="field.key">
      <!-- The section caption, rendered verbatim above its run (deployment-authored English, like
           the field labels themselves). Its testid is the same on every caption, because a caption
           is arbitrary Unicode a deployment writes in its own language: a spec addresses one by the
           TEXT it is asserting about (`getByTestId(...).filter({ hasText })`) rather than by a
           testid that would have to be slugified to be selectable. -->
      <p
        v-if="caption"
        class="-mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400"
        :class="{ 'pt-2': startsGroup }"
        :data-testid="`${testidPrefix}-section`"
      >
        {{ caption }}
      </p>
      <UFormField
        :label="field.label"
        :help="field.help"
        :required="field.required"
        :error="pathInvalid(field) ? t('common.pathInvalid') : undefined"
        :class="{ 'pt-2': startsGroup && !caption }"
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

        <!-- The declared bounds are INPUT HINTS only: `validateDescriptorFields` is what actually
             refuses a value, here and at every other door, so a stepper that respects them is a
             convenience rather than the check. `integer` steps by one; a field that admits
             fractions leaves `step` unset so the browser does not round the value away. -->
        <UInput
          v-else-if="field.type === 'number'"
          :model-value="numberStr(field.key)"
          type="number"
          class="w-full font-mono"
          :min="field.min"
          :max="field.max"
          :step="field.integer ? 1 : undefined"
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
    </template>
  </div>
</template>
