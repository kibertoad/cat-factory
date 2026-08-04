<script setup lang="ts">
// The ROUTE-ORDER editor for one model preset: which of a model's routes (its own provider API,
// AWS Bedrock, the OpenRouter gateway, Cloudflare Workers AI, a subscription harness) the preset's
// runs prefer, most preferred first.
//
// Two properties of the backend model decide the whole shape of this control:
//
//  - A preference REORDERS, never filters. So the list always shows EVERY route and the only
//    affordance is moving one. There is deliberately no way to remove a route: a preset that
//    could drop one would make a model whose only route is that one unstartable, which is not
//    what anybody choosing an order means.
//  - "No preference" is a real, distinct state from "an order that happens to match today's
//    default". Only the first keeps tracking the shipped order as the product changes it, so
//    reordering back to the default clears the preference rather than storing a copy of it, and
//    the header says which of the two the preset is in.
import { computed } from 'vue'
import {
  DEFAULT_MODEL_FLAVOR_ORDER,
  type ModelFlavor,
  orderedModelFlavorPreference,
} from '@cat-factory/contracts'

const props = defineProps<{
  /** The preset's stored order; empty/absent ⇒ the deployment's default order. */
  modelValue: ModelFlavor[] | undefined
}>()
const emit = defineEmits<{ 'update:modelValue': [ModelFlavor[] | undefined] }>()

const { t } = useI18n()

/** Static literal keys, one per route, so the typed-message-key check sees them all. */
const ROUTE_LABELS: Record<ModelFlavor, string> = {
  direct: 'settings.modelConfiguration.routes.direct',
  bedrock: 'settings.modelConfiguration.routes.bedrock',
  openrouter: 'settings.modelConfiguration.routes.openrouter',
  cloudflare: 'settings.modelConfiguration.routes.cloudflare',
  subscription: 'settings.modelConfiguration.routes.subscription',
}
const ROUTE_HINTS: Record<ModelFlavor, string> = {
  direct: 'settings.modelConfiguration.routeHints.direct',
  bedrock: 'settings.modelConfiguration.routeHints.bedrock',
  openrouter: 'settings.modelConfiguration.routeHints.openrouter',
  cloudflare: 'settings.modelConfiguration.routeHints.cloudflare',
  subscription: 'settings.modelConfiguration.routeHints.subscription',
}

/** The order actually in force: the preset's own, else the default. Always all five routes. */
const order = computed(() => orderedModelFlavorPreference(props.modelValue))
const isCustom = computed(() => (props.modelValue?.length ?? 0) > 0)

function sameAsDefault(next: readonly ModelFlavor[]): boolean {
  return next.every((flavor, i) => DEFAULT_MODEL_FLAVOR_ORDER[i] === flavor)
}

/**
 * Commit a reordering. An order equal to today's default is emitted as UNSET, so a preset never
 * pins a copy of the shipped order and silently stops following it when the product changes.
 */
function commit(next: ModelFlavor[]) {
  emit('update:modelValue', sameAsDefault(next) ? undefined : next)
}

function move(index: number, delta: number) {
  const next = [...order.value]
  const target = index + delta
  const moved = next[index]
  const displaced = next[target]
  if (!moved || !displaced) return
  next[index] = displaced
  next[target] = moved
  commit(next)
}

function reset() {
  emit('update:modelValue', undefined)
}
</script>

<template>
  <div>
    <div class="mb-1 flex items-start justify-between gap-3">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('settings.modelConfiguration.routeOrder.label') }}
      </span>
      <UButton
        v-if="isCustom"
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-rotate-ccw"
        data-testid="preset-route-order-reset"
        @click="reset"
      >
        {{ t('settings.modelConfiguration.routeOrder.reset') }}
      </UButton>
    </div>
    <p class="mb-2 text-[11px] leading-relaxed text-slate-500">
      {{
        isCustom
          ? t('settings.modelConfiguration.routeOrder.customHint')
          : t('settings.modelConfiguration.routeOrder.defaultHint')
      }}
    </p>
    <ol
      class="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/50"
      data-testid="preset-route-order"
    >
      <li
        v-for="(flavor, index) in order"
        :key="flavor"
        class="flex items-center gap-3 px-4 py-2.5"
        :data-testid="`preset-route-${flavor}`"
      >
        <span
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-slate-800 text-[10px] font-semibold text-slate-400"
        >
          {{ index + 1 }}
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm text-slate-200">{{ t(ROUTE_LABELS[flavor]) }}</p>
          <p class="truncate text-[11px] text-slate-500">{{ t(ROUTE_HINTS[flavor]) }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-chevron-up"
            :disabled="index === 0"
            :title="t('settings.modelConfiguration.routeOrder.moveUp')"
            :aria-label="t('settings.modelConfiguration.routeOrder.moveUp')"
            @click="move(index, -1)"
          />
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-chevron-down"
            :disabled="index === order.length - 1"
            :title="t('settings.modelConfiguration.routeOrder.moveDown')"
            :aria-label="t('settings.modelConfiguration.routeOrder.moveDown')"
            @click="move(index, 1)"
          />
        </div>
      </li>
    </ol>
  </div>
</template>
