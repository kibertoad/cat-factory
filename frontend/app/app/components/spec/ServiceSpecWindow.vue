<script setup lang="ts">
// Service-spec window — the dedicated surface for a service's prescriptive specification,
// opened from the inspector's "View Requirements" button (via the universal result-view
// host). It reads the sharded `spec/` artifact off the service repo's default branch and
// lets the human navigate the structured spec tree (modules → feature groups → requirements
// + acceptance criteria + domain rules). When the spec is present on main, a toggle switches
// to the rendered Gherkin scenarios (the seeded `.feature` files).
import type {
  RequirementGroup,
  RequirementItem,
  RequirementKind,
  RequirementPriority,
  RequirementState,
  SpecModule,
} from '~/types/spec'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import {
  filterRequirementsByState,
  requirementState,
  summarizeRequirementStates,
  summarizeSpecStates,
  type RequirementStateFilter,
} from './ServiceSpecWindow.logic'
import type { BadgeColor } from '~/utils/badge'

const { t } = useI18n()
const board = useBoardStore()
const serviceSpec = useServiceSpecStore()

type ViewMode = 'structured' | 'gherkin'
const mode = ref<ViewMode>('structured')
// Which half of the spec the reader wants: everything, only what the service is observed to
// honour, or only what is agreed but not built yet.
//
// DELIBERATELY STICKY ACROSS GROUPS, and reset only on open (alongside the view mode and the
// selection). "Show me what this service has actually proven" is a question about the SERVICE,
// so re-answering it on every group click would defeat the filter the moment the reader
// navigates. The cost is that a group with no match renders empty, which is why that case says
// so and offers a way back rather than leaving the reader stranded in a filter they may have
// set several groups ago.
const stateFilter = ref<RequirementStateFilter>('all')
// Selected feature group, keyed by its module + group index so a name collision can't
// cross-select. Null = show the service overview.
const selected = ref<{ m: number; g: number } | null>(null)

const { open, blockId, close } = useResultView('service-spec', {
  onOpen: ({ blockId }) => {
    mode.value = 'structured'
    stateFilter.value = 'all'
    selected.value = null
    void serviceSpec.load(blockId)
  },
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const view = computed(() => (blockId.value ? serviceSpec.viewFor(blockId.value) : undefined))
const loading = computed(() => (blockId.value ? serviceSpec.isLoading(blockId.value) : false))
const errored = computed(() => (blockId.value ? serviceSpec.isErrored(blockId.value) : false))
const spec = computed(() => view.value?.spec ?? null)
const modules = computed<SpecModule[]>(() => spec.value?.modules ?? [])
const present = computed(() => !!view.value?.present && !!spec.value)
const hasGherkin = computed(() => (view.value?.features.length ?? 0) > 0)

// Auto-select the first non-empty group once a present spec is shown, so the main pane isn't
// empty. Depends on `blockId` as well as `present`: switching directly to ANOTHER already-cached
// present block (via the inspector, without closing) changes `blockId` while `present` stays
// true, so a watch on `present` alone would never re-fire and the second block would open on
// the empty Overview pane. `immediate` covers the first, uncached open (present flips false→true
// after the load). `onOpen` resets `selected` to null first (it runs before this watch, since
// `useResultView` registers its blockId watch earlier), so a stale selection never leaks across.
watch(
  [present, blockId],
  ([is]) => {
    if (is && !selected.value) {
      const m = modules.value.findIndex((mod) => (mod.groups?.length ?? 0) > 0)
      if (m >= 0) selected.value = { m, g: 0 }
    }
  },
  { immediate: true },
)

const selectedModule = computed<SpecModule | null>(() =>
  selected.value ? (modules.value[selected.value.m] ?? null) : null,
)
const selectedGroup = computed<RequirementGroup | null>(() => {
  if (!selected.value) return null
  return selectedModule.value?.groups?.[selected.value.g] ?? null
})

// The Gherkin `.feature` content matching the selected group. Features carry display names
// (not slugs), and the harness permits same-named groups in one module (only the on-disk
// SLUGS are collision-suffixed), so a plain name match can cross-select. When several
// features share the (module, group) name pair, disambiguate by the group's ordinal among
// its same-named siblings — both lists derive from the same name-sorted walk, so the ordinals
// line up.
const selectedFeature = computed(() => {
  const mod = selectedModule.value
  const grp = selectedGroup.value
  if (!mod || !grp) return null
  const matches =
    view.value?.features.filter((f) => f.module === mod.name && f.group === grp.name) ?? []
  if (matches.length <= 1) return matches[0] ?? null
  const sameNamed = (mod.groups ?? []).filter((g) => g.name === grp.name)
  const ordinal = sameNamed.indexOf(grp)
  return matches[ordinal] ?? matches[0] ?? null
})

function selectGroup(m: number, g: number) {
  selected.value = { m, g }
}

// Re-fetch after a load failure — the only escape used to be close-and-reopen.
function retry() {
  if (blockId.value) void serviceSpec.load(blockId.value)
}

// Exhaustive priority → label/chip map. Literal `t()` keys keep the typed-key drift
// guard live, vs a runtime-built `spec.priority.${value}`.
const PRIORITY_META: Record<RequirementPriority, { label: string; chip: BadgeColor }> = {
  must: { label: t('spec.priority.must'), chip: 'error' },
  should: { label: t('spec.priority.should'), chip: 'warning' },
  could: { label: t('spec.priority.could'), chip: 'neutral' },
}

// Exhaustive requirement-kind → label map (closed union from the contracts).
const KIND_LABELS: Record<RequirementKind, string> = {
  functional: t('spec.kind.functional'),
  nonfunctional: t('spec.kind.nonfunctional'),
  constraint: t('spec.kind.constraint'),
}

// Exhaustive implementation-state → presentation map. `established` is the only state that
// means "the service is observed to do this"; everything else is a behaviour that has been
// agreed and not yet seen to hold, which must never read as standing behaviour.
const STATE_META: Record<RequirementState, { label: string; chip: BadgeColor; icon: string }> = {
  established: {
    label: t('spec.state.established'),
    chip: 'success',
    icon: 'i-lucide-circle-check',
  },
  aspirational: {
    label: t('spec.state.aspirational'),
    chip: 'neutral',
    icon: 'i-lucide-circle-dashed',
  },
}

// The state filter's three choices. The two state choices REUSE the badge labels rather than
// carrying their own catalog keys: a chip that reads differently from the badge it filters for
// is a translation bug waiting to happen, and one key per state cannot drift from itself. Only
// `all` needs a key of its own, and it is a literal `t()` so the typed-key drift guard stays live.
const STATE_FILTERS: { value: RequirementStateFilter; label: string }[] = [
  { value: 'all', label: t('spec.state.filter.all') },
  { value: 'established', label: STATE_META.established.label },
  { value: 'aspirational', label: STATE_META.aspirational.label },
]

// Service-wide rollup, shown on the overview pane: how much of the written-down behaviour the
// service is actually known to honour.
const specStates = computed(() => summarizeSpecStates(modules.value))
// The selected group's rollup + the requirements the filter admits.
const groupStates = computed(() => summarizeRequirementStates(selectedGroup.value?.requirements))
const visibleRequirements = computed(() =>
  filterRequirementsByState(selectedGroup.value?.requirements, stateFilter.value),
)

function reqCount(group: RequirementGroup): number {
  return group.requirements?.length ?? 0
}
function stateMeta(item: RequirementItem) {
  return STATE_META[requirementState(item)]
}
function priorityMeta(item: RequirementItem) {
  return PRIORITY_META[item.priority] ?? PRIORITY_META.could
}
function kindLabel(item: RequirementItem): string {
  return KIND_LABELS[item.kind] ?? item.kind
}
</script>

<template>
  <ResultWindowShell
    :open="open"
    icon="i-lucide-scroll-text"
    icon-class="bg-indigo-500/15 text-indigo-300"
    :title="t('spec.title')"
    :subtitle="block ? spec?.service || block.title : undefined"
    variant="centered"
    width="full"
    @close="close"
  >
    <!-- view toggle: Gherkin only when the spec (and its feature files) are on main -->
    <template v-if="present" #header-extras>
      <div class="flex items-center rounded-lg border border-slate-700 p-0.5">
        <UButton
          :color="mode === 'structured' ? 'primary' : 'neutral'"
          :variant="mode === 'structured' ? 'soft' : 'ghost'"
          size="xs"
          icon="i-lucide-list-tree"
          @click="
            () => {
              mode = 'structured'
            }
          "
        >
          {{ t('spec.mode.structured') }}
        </UButton>
        <UButton
          :color="mode === 'gherkin' ? 'primary' : 'neutral'"
          :variant="mode === 'gherkin' ? 'soft' : 'ghost'"
          size="xs"
          icon="i-lucide-square-check-big"
          :disabled="!hasGherkin"
          :title="hasGherkin ? t('spec.mode.gherkinTooltip') : t('spec.mode.gherkinNone')"
          @click="
            () => {
              mode = 'gherkin'
            }
          "
        >
          {{ t('spec.mode.gherkin') }}
        </UButton>
      </div>
    </template>

    <!-- loading -->
    <div
      v-if="loading && !view"
      class="flex flex-1 items-center justify-center gap-2 text-sm text-slate-400"
    >
      <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
      {{ t('spec.loading') }}
    </div>

    <!-- error -->
    <div
      v-else-if="errored"
      class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-slate-400"
    >
      <UIcon name="i-lucide-triangle-alert" class="h-6 w-6 text-amber-400" />
      {{ t('spec.error') }}
      <UButton
        icon="i-lucide-rotate-cw"
        color="neutral"
        variant="soft"
        size="xs"
        :loading="loading"
        @click="retry"
      >
        {{ t('common.retry') }}
      </UButton>
    </div>

    <!-- empty: no spec on the repo's default branch yet -->
    <div
      v-else-if="!present"
      class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <UIcon name="i-lucide-scroll-text" class="h-8 w-8 text-slate-600" />
      <div>
        <p class="text-sm font-medium text-slate-300">{{ t('spec.empty.title') }}</p>
        <p class="mx-auto mt-1 max-w-md text-xs text-slate-500">
          {{ t('spec.empty.description') }}
        </p>
      </div>
    </div>

    <!-- spec body: navigable tree + detail -->
    <div v-else class="flex min-h-0 flex-1">
      <!-- nav: modules → feature groups -->
      <nav class="w-64 shrink-0 overflow-y-auto border-e border-slate-800 px-3 py-4">
        <UButton
          block
          class="mb-2 justify-start"
          :color="selected === null ? 'primary' : 'neutral'"
          :variant="selected === null ? 'soft' : 'ghost'"
          size="xs"
          icon="i-lucide-info"
          @click="
            () => {
              selected = null
            }
          "
        >
          {{ t('spec.overview') }}
        </UButton>
        <div v-for="(mod, mi) in modules" :key="mi" class="mb-3">
          <div class="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {{ mod.name }}
          </div>
          <ul class="space-y-0.5">
            <li v-for="(group, gi) in mod.groups ?? []" :key="gi">
              <button
                type="button"
                class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-[13px] transition"
                :class="
                  selected?.m === mi && selected?.g === gi
                    ? 'bg-indigo-500/15 text-indigo-200'
                    : 'text-slate-300 hover:bg-slate-800'
                "
                @click="selectGroup(mi, gi)"
              >
                <span class="truncate">{{ group.name }}</span>
                <span class="shrink-0 text-[10px] text-slate-500">{{ reqCount(group) }}</span>
              </button>
            </li>
            <li
              v-if="(mod.groups?.length ?? 0) === 0"
              class="px-2 py-1 text-[11px] italic text-slate-600"
            >
              {{ t('spec.noFeatureGroups') }}
            </li>
          </ul>
        </div>
      </nav>

      <!-- detail -->
      <div class="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <!-- service overview -->
        <template v-if="selected === null">
          <h2 class="text-lg font-semibold text-white">{{ spec?.service }}</h2>
          <!-- The service's own prose, so it takes the reading measure the shell's `full` width
               obliges (see the `width` prop). The requirement rows and Gherkin blocks below keep
               the full span — they are structure, not paragraphs. -->
          <p v-if="spec?.summary" class="mt-2 max-w-3xl whitespace-pre-line text-sm text-slate-300">
            {{ spec.summary }}
          </p>
          <p v-else class="mt-2 text-sm text-slate-500">{{ t('spec.noSummary') }}</p>
          <!-- implementation-state rollup: how much of the written-down behaviour is observed
               to hold, rather than merely agreed -->
          <div
            v-if="specStates.total > 0"
            class="mt-4 flex flex-wrap items-center gap-2 text-xs"
            data-testid="spec-state-rollup"
          >
            <UBadge color="success" variant="subtle" size="sm">
              {{ t('spec.state.establishedCount', { count: specStates.established }) }}
            </UBadge>
            <UBadge color="neutral" variant="subtle" size="sm">
              {{ t('spec.state.aspirationalCount', { count: specStates.aspirational }) }}
            </UBadge>
            <span class="text-slate-500">{{ t('spec.state.rollupHint') }}</span>
          </div>
          <p class="mt-4 text-xs text-slate-500">
            {{
              hasGherkin
                ? t('spec.moduleHintGherkin', { count: modules.length }, modules.length)
                : t('spec.moduleHint', { count: modules.length }, modules.length)
            }}
          </p>
        </template>

        <!-- selected feature group -->
        <template v-else-if="selectedGroup">
          <div class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
            {{ selectedModule?.name }}
          </div>
          <h2 class="text-lg font-semibold text-white">{{ selectedGroup.name }}</h2>
          <p v-if="selectedGroup.summary" class="mt-1 max-w-3xl text-sm text-slate-400">
            {{ selectedGroup.summary }}
          </p>

          <!-- GHERKIN view: the rendered .feature file for this group -->
          <template v-if="mode === 'gherkin'">
            <pre
              v-if="selectedFeature"
              class="mt-4 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-[12.5px] leading-relaxed text-slate-200"
            ><code>{{ selectedFeature.content }}</code></pre>
            <div
              v-else
              class="mt-4 rounded-lg border border-dashed border-slate-700 p-6 text-center text-sm text-slate-500"
            >
              {{ t('spec.noGherkinForGroup') }}
            </div>
          </template>

          <!-- STRUCTURED view: requirements + acceptance + domain rules -->
          <template v-else>
            <div v-if="reqCount(selectedGroup) === 0" class="mt-4 text-sm text-slate-500">
              {{ t('spec.noRequirements') }}
            </div>
            <!-- per-group implementation-state rollup + the filter over the two halves -->
            <div
              v-else
              class="mt-4 flex flex-wrap items-center justify-between gap-2"
              data-testid="spec-state-filter"
            >
              <div class="flex items-center gap-1.5 text-[11px] text-slate-500">
                <UIcon :name="STATE_META.established.icon" class="h-3.5 w-3.5 text-emerald-400" />
                {{
                  t('spec.state.groupRollup', {
                    established: groupStates.established,
                    total: groupStates.total,
                  })
                }}
              </div>
              <div class="flex items-center rounded-lg border border-slate-700 p-0.5">
                <UButton
                  v-for="option in STATE_FILTERS"
                  :key="option.value"
                  :color="stateFilter === option.value ? 'primary' : 'neutral'"
                  :variant="stateFilter === option.value ? 'soft' : 'ghost'"
                  size="xs"
                  :data-testid="`spec-state-filter-${option.value}`"
                  @click="
                    () => {
                      stateFilter = option.value
                    }
                  "
                >
                  {{ option.label }}
                </UButton>
              </div>
            </div>
            <!-- the filter can legitimately empty a non-empty group; say so rather than
                 rendering a blank pane that reads like "no requirements". The filter is sticky
                 across groups, so the reader may have set it several groups ago — offer the way
                 back here rather than making them find the toggle again. -->
            <div
              v-if="reqCount(selectedGroup) > 0 && visibleRequirements.length === 0"
              class="mt-4 flex flex-wrap items-center gap-2 text-sm text-slate-500"
              data-testid="spec-state-filter-empty"
            >
              {{ t('spec.state.noneMatchFilter') }}
              <UButton
                color="primary"
                variant="link"
                size="xs"
                class="p-0"
                data-testid="spec-state-filter-reset"
                @click="
                  () => {
                    stateFilter = 'all'
                  }
                "
              >
                {{ t('spec.state.showAll') }}
              </UButton>
            </div>
            <ul class="mt-4 space-y-4">
              <li
                v-for="req in visibleRequirements"
                :key="req.id"
                class="rounded-lg border border-slate-800 bg-slate-900/60 p-4"
              >
                <div class="flex items-start justify-between gap-3">
                  <h3 class="text-sm font-semibold text-slate-100">{{ req.title }}</h3>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <!-- implementation state: agreed vs observed to hold. The distinction the
                         build prompt and the tester act on, so a reader must see it too. -->
                    <UBadge
                      :color="stateMeta(req).chip"
                      variant="subtle"
                      size="sm"
                      :icon="stateMeta(req).icon"
                      :data-testid="`spec-requirement-state-${requirementState(req)}`"
                    >
                      {{ stateMeta(req).label }}
                    </UBadge>
                    <UBadge :color="priorityMeta(req).chip" variant="subtle" size="sm">
                      {{ priorityMeta(req).label }}
                    </UBadge>
                    <UBadge color="neutral" variant="subtle" size="sm">{{ kindLabel(req) }}</UBadge>
                  </div>
                </div>
                <p class="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-slate-300">
                  {{ req.statement }}
                </p>
                <!-- acceptance criteria (Given/When/Then) -->
                <div v-if="(req.acceptance?.length ?? 0) > 0" class="mt-3 space-y-1.5">
                  <div
                    v-for="ac in req.acceptance ?? []"
                    :key="ac.id"
                    class="rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2 text-[12.5px] leading-relaxed"
                  >
                    <p class="text-slate-300">
                      <span class="font-semibold text-emerald-400">{{
                        t('spec.acceptance.given')
                      }}</span>
                      {{ ac.given }}
                    </p>
                    <p class="text-slate-300">
                      <span class="font-semibold text-sky-400">{{
                        t('spec.acceptance.when')
                      }}</span>
                      {{ ac.when }}
                    </p>
                    <p class="text-slate-300">
                      <span class="font-semibold text-violet-400">{{
                        t('spec.acceptance.then')
                      }}</span>
                      {{ ac.outcome }}
                    </p>
                  </div>
                </div>
              </li>
            </ul>

            <!-- domain rules / invariants scoped to this group -->
            <div v-if="(selectedGroup.rules?.length ?? 0) > 0" class="mt-6">
              <div
                class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400"
              >
                <UIcon name="i-lucide-shield-check" class="h-3.5 w-3.5" />
                {{ t('spec.domainRules') }}
              </div>
              <ul class="max-w-3xl space-y-1.5">
                <li
                  v-for="rule in selectedGroup.rules ?? []"
                  :key="rule.id"
                  class="rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-[13px] text-slate-300"
                >
                  {{ rule.rule }}
                  <span v-if="rule.rationale" class="text-slate-500">{{
                    t('spec.ruleRationale', { rationale: rule.rationale })
                  }}</span>
                </li>
              </ul>
            </div>
          </template>
        </template>
      </div>
    </div>
  </ResultWindowShell>
</template>
