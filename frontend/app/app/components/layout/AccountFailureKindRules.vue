<script setup lang="ts">
import { computed } from 'vue'
import type { AgentFailureKind, PlatformFailureKindRule } from '~/types/execution'
import {
  AGENT_FAILURE_KINDS,
  FAILURE_KIND_KEYS,
  failureKindRuleFaults,
  isAgentFailureKind,
  MAX_FAILURE_KIND_RULES,
} from '~/utils/failureKinds'

// The per-failure-kind alert rules of the platform-health sheet: "page when `evicted` reaches
// 5% of the window's failures". Its own component because it edits a LIST where
// its parent edits scalars, and the two have different notions of what an override is.
//
// That difference is the whole of this file. A scalar override is per field: leave the box
// empty and that one ceiling inherits. A list cannot work that way — merging rule by rule would
// let an account retune a deployment rule but never DROP one, and silently reinstating a rule an
// operator deleted is the worse failure for something wired to a pager. So the account's list
// REPLACES the deployment's, which makes "no rules at all" a setting somebody can choose, and
// makes it indistinguishable from "inherit" unless the two are asked separately. Hence the
// explicit override switch: off omits the field, on sends the list, empty included.

const props = defineProps<{
  /** The account's rules, or undefined when it inherits the deployment's. */
  modelValue: PlatformFailureKindRule[] | undefined
}>()
const emit = defineEmits<{ 'update:modelValue': [PlatformFailureKindRule[] | undefined] }>()

const { t } = useI18n()

const overriding = computed(() => props.modelValue !== undefined)
const rules = computed(() => props.modelValue ?? [])

/**
 * The kinds offered for a row: the known vocabulary, plus whatever this row already names.
 *
 * The second half matters on exactly the row that would otherwise lose data. A rule stored
 * against a kind a later release RETIRED still parses (the contract keeps the field a string so
 * one stale rule cannot take the account's whole settings row down with it), so it reaches this
 * editor, and a select that only offered current members would silently re-point it at the first
 * one the moment anything else on the sheet was saved. It is offered back, marked unrecognised,
 * so the human decides whether to re-pick it or drop it.
 */
function kindItems(current: string) {
  const known = AGENT_FAILURE_KINDS.map((kind) => ({
    label: t(FAILURE_KIND_KEYS[kind]),
    value: kind as string,
  }))
  if (current === '' || isAgentFailureKind(current)) return known
  return [
    ...known,
    {
      label: t('settings.platformAlerts.failureKinds.unknownKind', { kind: current }),
      value: current,
    },
  ]
}

/** The kinds already spoken for, so the UI can say which row is the duplicate. */
const duplicateKinds = computed(() => {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const rule of rules.value) {
    if (seen.has(rule.kind)) dupes.add(rule.kind)
    seen.add(rule.kind)
  }
  return dupes
})

/** A share is edited in PERCENT, which is how the rule is spoken ("5% or more"), stored 0..1. */
function sharePercent(rule: PlatformFailureKindRule): number {
  return Math.round(rule.maxShare * 1000) / 10
}

function setOverriding(on: boolean) {
  // Turning the override ON starts from the empty list rather than a seeded row: an editor that
  // invented a rule would have the human deleting a page they never asked for.
  emit('update:modelValue', on ? [] : undefined)
}

function patch(index: number, next: Partial<PlatformFailureKindRule>) {
  emit(
    'update:modelValue',
    rules.value.map((rule, i) => (i === index ? { ...rule, ...next } : rule)),
  )
}

function setShare(index: number, raw: string) {
  const percent = Number(raw.trim())
  // A blank or unreadable box is left at zero rather than dropped: `maxShare` has no "unset"
  // (a rule without a ceiling is not a rule), and 0 is refused by the contract, so an incomplete
  // row is REPORTED by `faults` below instead of being quietly discarded on save.
  patch(index, { maxShare: Number.isFinite(percent) ? percent / 100 : 0 })
}

function setMinCount(index: number, raw: string) {
  const trimmed = raw.trim()
  if (trimmed === '') {
    const { minCount: _dropped, ...rest } = rules.value[index]!
    emit(
      'update:modelValue',
      rules.value.map((rule, i) => (i === index ? rest : rule)),
    )
    return
  }
  const parsed = Number(trimmed)
  patch(index, { minCount: Number.isFinite(parsed) ? Math.round(parsed) : 1 })
}

/**
 * The first kind nothing has claimed, or undefined once every one is spoken for.
 *
 * Undefined is what DISABLES the add button, rather than seeding a duplicate of the first kind
 * and letting the duplicate warning explain it afterwards: at most one rule per kind is the
 * contract, so a row the editor can only add in a state the contract refuses is a row it should
 * not offer. It also puts the list's cap out of reach by construction — the vocabulary is far
 * shorter than `MAX_FAILURE_KIND_RULES`, so unique-by-kind is the binding limit.
 */
const nextFreeKind = computed<AgentFailureKind | undefined>(() => {
  const taken = new Set(rules.value.map((rule) => rule.kind))
  return AGENT_FAILURE_KINDS.find((kind) => !taken.has(kind))
})

function addRule() {
  const kind = nextFreeKind.value
  if (kind === undefined) return
  emit('update:modelValue', [...rules.value, { kind, maxShare: 0.05 }])
}

function removeRule(index: number) {
  emit(
    'update:modelValue',
    rules.value.filter((_, i) => i !== index),
  )
}

/**
 * What the backend would refuse about this list. The same helper the parent's save path calls,
 * so what the sheet flags and what the save stops on cannot disagree.
 */
const faults = computed(() => failureKindRuleFaults(rules.value))
</script>

<template>
  <div class="space-y-2" data-testid="platform-alert-failure-kinds">
    <label class="text-[11px] font-medium text-slate-300">
      {{ t('settings.platformAlerts.failureKinds.label') }}
    </label>
    <p class="text-[11px] text-slate-400">
      {{ t('settings.platformAlerts.failureKinds.description') }}
    </p>

    <div class="space-y-1">
      <UCheckbox
        :model-value="overriding"
        size="sm"
        :label="t('settings.platformAlerts.failureKinds.overrideLabel')"
        data-testid="platform-alert-failure-kinds-override"
        @update:model-value="setOverriding(!!$event)"
      />
      <p class="ps-6 text-[11px] text-slate-400">
        {{ t('settings.platformAlerts.failureKinds.overrideHint') }}
      </p>
    </div>

    <template v-if="overriding">
      <p
        v-if="rules.length === 0"
        class="text-[11px] text-slate-500"
        data-testid="platform-alert-failure-kinds-empty"
      >
        {{ t('settings.platformAlerts.failureKinds.empty') }}
      </p>

      <div
        v-for="(rule, index) in rules"
        :key="index"
        class="grid grid-cols-1 items-end gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]"
        :data-testid="`platform-alert-failure-kind-row-${index}`"
      >
        <div class="space-y-1">
          <label class="block text-[11px] text-slate-300">
            {{ t('settings.platformAlerts.failureKinds.kindLabel') }}
          </label>
          <USelect
            :model-value="rule.kind"
            :items="kindItems(rule.kind)"
            value-key="value"
            size="sm"
            :data-testid="`platform-alert-failure-kind-${index}`"
            @update:model-value="patch(index, { kind: String($event) })"
          />
        </div>
        <div class="space-y-1">
          <label class="block text-[11px] text-slate-300">
            {{ t('settings.platformAlerts.failureKinds.shareLabel') }}
          </label>
          <UInput
            :model-value="String(sharePercent(rule))"
            type="number"
            step="1"
            size="sm"
            :data-testid="`platform-alert-failure-share-${index}`"
            @update:model-value="setShare(index, String($event))"
          />
          <p v-if="index === 0" class="text-[11px] text-slate-500">
            {{ t('settings.platformAlerts.failureKinds.shareHint') }}
          </p>
        </div>
        <div class="space-y-1">
          <label class="block text-[11px] text-slate-300">
            {{ t('settings.platformAlerts.failureKinds.minCountLabel') }}
          </label>
          <UInput
            :model-value="rule.minCount === undefined ? '' : String(rule.minCount)"
            type="number"
            step="1"
            size="sm"
            :placeholder="t('settings.platformAlerts.failureKinds.minCountPlaceholder')"
            :data-testid="`platform-alert-failure-min-count-${index}`"
            @update:model-value="setMinCount(index, String($event))"
          />
        </div>
        <UButton
          color="neutral"
          variant="subtle"
          size="xs"
          icon="i-lucide-trash-2"
          :aria-label="t('settings.platformAlerts.failureKinds.removeRule')"
          :data-testid="`platform-alert-failure-remove-${index}`"
          @click="removeRule(index)"
        />
      </div>

      <p
        v-if="faults.tooMany"
        class="text-[11px] text-amber-300"
        data-testid="platform-alert-failure-kinds-too-many"
      >
        {{
          t('settings.platformAlerts.failureKinds.tooManyRules', { max: MAX_FAILURE_KIND_RULES })
        }}
      </p>
      <p
        v-else-if="duplicateKinds.size > 0"
        class="text-[11px] text-amber-300"
        data-testid="platform-alert-failure-kinds-duplicate"
      >
        {{ t('settings.platformAlerts.failureKinds.duplicateKind') }}
      </p>
      <p
        v-else-if="faults.rows.length > 0"
        class="text-[11px] text-amber-300"
        data-testid="platform-alert-failure-kinds-invalid"
      >
        {{
          t('settings.platformAlerts.failureKinds.invalidRows', { rows: faults.rows.join(', ') })
        }}
      </p>

      <UButton
        color="neutral"
        variant="subtle"
        size="xs"
        icon="i-lucide-plus"
        :disabled="nextFreeKind === undefined"
        data-testid="platform-alert-failure-kinds-add"
        @click="addRule"
      >
        {{ t('settings.platformAlerts.failureKinds.addRule') }}
      </UButton>
      <p
        v-if="nextFreeKind === undefined"
        class="text-[11px] text-slate-500"
        data-testid="platform-alert-failure-kinds-all-covered"
      >
        {{ t('settings.platformAlerts.failureKinds.allKindsCovered') }}
      </p>
      <p class="text-[11px] text-slate-500">
        {{ t('settings.platformAlerts.failureKinds.minCountHint') }}
      </p>
    </template>
  </div>
</template>
