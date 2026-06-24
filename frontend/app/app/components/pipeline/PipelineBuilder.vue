<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentKind, Pipeline } from '~/types/domain'
import AgentPalette from '~/components/palettes/AgentPalette.vue'
import AgentKindIcon from '~/components/pipeline/AgentKindIcon.vue'
import { agentKindMeta, companionForProducer, isConsensusEligibleKind } from '~/utils/catalog'
import type { ConsensusStrategy } from '~/types/consensus'

type DraftUnit = { index: number; kind: AgentKind; companionIndex: number | null }

const pipelines = usePipelinesStore()

const CONSENSUS_STRATEGIES: { value: ConsensusStrategy; label: string }[] = [
  { value: 'specialist-panel', label: 'Specialist panel' },
  { value: 'debate', label: 'Debate' },
  { value: 'ranked-voting', label: 'Ranked voting' },
]

/** Add a blank participant to the draft step's consensus config. */
function addParticipant(i: number) {
  const cfg = pipelines.draftConsensus[i]
  if (!cfg) return
  cfg.participants.push({ id: `cp_${Math.random().toString(36).slice(2, 9)}`, role: 'Reviewer' })
}
function removeParticipant(i: number, pIdx: number) {
  pipelines.draftConsensus[i]?.participants.splice(pIdx, 1)
}
/** Toggle gating on/off for a draft step's consensus config. */
function toggleGating(i: number) {
  const cfg = pipelines.draftConsensus[i]
  if (!cfg) return
  cfg.gating = cfg.gating?.enabled
    ? { ...cfg.gating, enabled: false }
    : { enabled: true, minRisk: 0.6, minImpact: 0.6 }
}
const agents = useAgentsStore()
const ui = useUiStore()
const releaseHealth = useReleaseHealthStore()

const open = computed({
  get: () => ui.builderOpen,
  set: (v: boolean) => (ui.builderOpen = v),
})

// Refresh the observability-integration state whenever the builder opens so the palette
// knows whether to offer the post-release-health gate (it's loaded on demand, not from
// the snapshot). Best-effort: a failure just leaves the gate hidden.
watch(open, (isOpen) => {
  if (isOpen) releaseHealth.load().catch(() => {})
})

function add(kind: AgentKind) {
  pipelines.addToDraft(kind)
}

// Saved pipelines render collapsed (name + step count); a click expands the full
// ordered step list. Tracking expansion as a Set keyed by pipeline id keeps the
// icon row from overflowing the narrow panel the way an always-on inline list did.
const expandedSaved = ref<Set<string>>(new Set())
function toggleSaved(id: string) {
  const next = new Set(expandedSaved.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedSaved.value = next
}

const toast = useToast()

// ---- "Add agent" mini-form -------------------------------------------------
const addAgentOpen = ref(false)
const newAgentName = ref('')
const newAgentDesc = ref('')

function openAddAgent() {
  newAgentName.value = ''
  newAgentDesc.value = ''
  addAgentOpen.value = true
}

function createAgent() {
  const agent = agents.addAgent({
    label: newAgentName.value,
    description: newAgentDesc.value,
  })
  toast.add({ title: `Added agent “${agent.label}”`, color: 'success', icon: 'i-lucide-check' })
  addAgentOpen.value = false
}

function placeholder(what: string) {
  toast.add({ title: 'Placeholder', description: what, icon: 'i-lucide-construction' })
}

async function save() {
  const wasEditing = pipelines.editingId !== null
  try {
    const saved = await pipelines.saveDraft()
    if (saved) {
      toast.add({
        title: wasEditing ? `Updated “${saved.name}”` : `Saved “${saved.name}”`,
        color: 'success',
        icon: 'i-lucide-check',
      })
      ui.builderOpen = false
    } else {
      toast.add({ title: 'Add at least one agent first', color: 'warning' })
    }
  } catch (e) {
    // Surface the backend reason (e.g. post-release-health rejected without an
    // observability integration) rather than a generic failure.
    toast.add({
      title: 'Could not save pipeline',
      description: e instanceof Error ? e.message : undefined,
      color: 'error',
    })
  }
}

/** Remove a producer unit, taking its attached companion with it (companion index first). */
function removeUnit(unit: DraftUnit) {
  if (unit.companionIndex !== null) pipelines.removeFromDraft(unit.companionIndex)
  pipelines.removeFromDraft(unit.index)
}

/** Enable/disable a producer unit, keeping its attached companion's enable flag in sync. */
function toggleEnabled(unit: DraftUnit) {
  pipelines.toggleDraftEnabled(unit.index)
  if (unit.companionIndex !== null) {
    pipelines.draftEnabled[unit.companionIndex] = pipelines.draftEnabled[unit.index] !== false
  }
}

function companionLabel(kind: string): string | null {
  const companion = companionForProducer(kind)
  return companion ? agentKindMeta(companion).label : null
}

// Surfaced as an inline hint: a gated step needs a task-estimator before it (mirrors the
// backend validation, which also rejects the save/start).
const gatingNeedsEstimator = computed(() => {
  const kinds = pipelines.draft
  for (let i = 0; i < kinds.length; i++) {
    if (!pipelines.draftGating[i]?.enabled || pipelines.draftEnabled[i] === false) continue
    const hasEstimator = kinds
      .slice(0, i)
      .some((k, j) => k === 'task-estimator' && pipelines.draftEnabled[j] !== false)
    if (!hasEstimator) return true
  }
  return false
})

// ---- draft labels ----------------------------------------------------------
const newLabel = ref('')
function addLabel() {
  const v = newLabel.value.trim()
  if (v && !pipelines.draftLabels.includes(v)) pipelines.draftLabels.push(v)
  newLabel.value = ''
}
function removeLabel(label: string) {
  pipelines.draftLabels = pipelines.draftLabels.filter((l) => l !== label)
}

// ---- saved-pipeline library filtering --------------------------------------
const labelFilter = ref<string | null>(null)
const showArchived = ref(false)
const allLabels = computed(() =>
  [...new Set(pipelines.pipelines.flatMap((p) => p.labels ?? []))].sort(),
)
const archivedCount = computed(() => pipelines.pipelines.filter((p) => p.archived).length)
const visiblePipelines = computed(() =>
  pipelines.pipelines.filter((p) => {
    if (!showArchived.value && p.archived) return false
    if (labelFilter.value && !(p.labels ?? []).includes(labelFilter.value)) return false
    return true
  }),
)
async function toggleArchive(p: Pipeline) {
  try {
    if (p.archived) await pipelines.unarchive(p.id)
    else await pipelines.archive(p.id)
  } catch {
    toast.add({ title: 'Could not update pipeline', color: 'error' })
  }
}

/** Load a custom pipeline into the draft for in-place editing. */
function edit(p: Pipeline) {
  pipelines.loadForEdit(p)
}

/** Clone any pipeline (incl. a read-only built-in) into an editable copy, then edit it. */
async function clone(p: Pipeline) {
  try {
    const copy = await pipelines.clonePipeline(p.id)
    toast.add({
      title: `Cloned “${p.name}” — now editing “${copy.name}”`,
      color: 'success',
      icon: 'i-lucide-copy',
    })
  } catch {
    toast.add({ title: 'Could not clone pipeline', color: 'error' })
  }
}
</script>

<template>
  <USlideover v-model:open="open" title="Pipeline builder" side="left">
    <template #body>
      <div class="grid h-full grid-cols-2 gap-4">
        <!-- agent palette -->
        <div class="overflow-y-auto pr-1">
          <div class="mb-2 flex items-center justify-between gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Agent palette
            </h3>
            <UButton
              color="primary"
              variant="soft"
              size="xs"
              icon="i-lucide-plus"
              @click="openAddAgent"
            >
              Add agent
            </UButton>
          </div>
          <AgentPalette @add="add" />
        </div>

        <!-- draft chain -->
        <div class="flex flex-col">
          <div class="mb-2 flex items-center justify-between gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-slate-400">Pipeline</h3>
            <UButton
              color="neutral"
              variant="soft"
              size="xs"
              icon="i-lucide-cpu"
              title="Manage model presets (which model each agent runs on)"
              @click="ui.openModelConfig()"
            >
              Configure models
            </UButton>
          </div>
          <UInput
            v-model="pipelines.draftName"
            placeholder="Pipeline name"
            size="sm"
            class="mb-2"
          />

          <!-- Labels: organize the pipeline in the library (filter/search). -->
          <div class="mb-3 flex flex-wrap items-center gap-1.5">
            <UBadge
              v-for="l in pipelines.draftLabels"
              :key="l"
              color="neutral"
              variant="soft"
              size="xs"
              class="gap-1"
            >
              {{ l }}
              <button type="button" class="hover:text-rose-400" @click="removeLabel(l)">
                <UIcon name="i-lucide-x" class="h-3 w-3" />
              </button>
            </UBadge>
            <input
              v-model="newLabel"
              placeholder="+ label"
              class="w-20 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[11px] text-slate-200 focus:w-28"
              @keydown.enter.prevent="addLabel"
              @blur="addLabel"
            />
          </div>

          <p
            v-if="gatingNeedsEstimator"
            class="mb-2 flex items-center gap-1.5 rounded-md border border-amber-800/50 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-300"
          >
            <UIcon name="i-lucide-alert-triangle" class="h-3.5 w-3.5 shrink-0" />
            A gated step needs a Task Estimator before it — add one or the pipeline won't save.
          </p>

          <div
            v-if="pipelines.draft.length === 0"
            class="flex flex-1 items-center justify-center rounded-lg border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500"
          >
            Click agents on the left to assemble a linear pipeline.
          </div>

          <ol v-else class="flex-1 space-y-2 overflow-y-auto">
            <li
              v-for="(unit, vi) in pipelines.units"
              :key="unit.index"
              class="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-800/60 p-2"
              :class="{ 'opacity-50': pipelines.draftEnabled[unit.index] === false }"
            >
              <div class="flex items-center gap-1.5">
                <span class="w-4 shrink-0 text-center text-[10px] text-slate-500">{{
                  vi + 1
                }}</span>
                <AgentKindIcon :kind="unit.kind" icon-class="h-4 w-4" />
                <span
                  class="min-w-0 flex-1 truncate text-xs text-slate-100"
                  :class="{ 'line-through': pipelines.draftEnabled[unit.index] === false }"
                  :title="agentKindMeta(unit.kind).description"
                >
                  {{ agentKindMeta(unit.kind).label }}
                </span>
                <div class="flex shrink-0 items-center">
                  <!-- Companion toggle: attach/detach the dependent reviewer for this producer. -->
                  <UButton
                    v-if="companionForProducer(unit.kind)"
                    :icon="
                      unit.companionIndex !== null ? 'i-lucide-scan-eye' : 'i-lucide-scan-search'
                    "
                    :color="unit.companionIndex !== null ? 'secondary' : 'neutral'"
                    variant="ghost"
                    size="xs"
                    :title="
                      unit.companionIndex !== null
                        ? `Remove the ${companionLabel(unit.kind)} for this step`
                        : `Add the ${companionLabel(unit.kind)} (reviews this step, loops it back below threshold)`
                    "
                    @click="pipelines.toggleCompanion(unit.index)"
                  />
                  <!-- Enable/disable: keep the step in the pipeline but skip it at run. -->
                  <UButton
                    :icon="
                      pipelines.draftEnabled[unit.index] === false
                        ? 'i-lucide-eye-off'
                        : 'i-lucide-eye'
                    "
                    :color="pipelines.draftEnabled[unit.index] === false ? 'neutral' : 'primary'"
                    variant="ghost"
                    size="xs"
                    :title="
                      pipelines.draftEnabled[unit.index] === false
                        ? 'Step disabled (skipped at run) — click to enable'
                        : 'Disable this step (kept in the pipeline but skipped at run)'
                    "
                    @click="toggleEnabled(unit)"
                  />
                  <!-- Approval gate: pause after this step so a human reviews (and
                     can edit) its proposal before the next step runs. -->
                  <UButton
                    :icon="
                      pipelines.draftGates[unit.index] ? 'i-lucide-shield-check' : 'i-lucide-shield'
                    "
                    :color="pipelines.draftGates[unit.index] ? 'warning' : 'neutral'"
                    variant="ghost"
                    size="xs"
                    :title="
                      pipelines.draftGates[unit.index]
                        ? 'Approval required after this step — click to remove the gate'
                        : 'Require human approval after this step'
                    "
                    @click="pipelines.toggleDraftGate(unit.index)"
                  />
                  <!-- Consensus: run this step through the multi-model mechanism (eligible
                     kinds only — architect/analysis/task-estimator). -->
                  <UButton
                    v-if="isConsensusEligibleKind(unit.kind)"
                    :icon="
                      pipelines.draftConsensus[unit.index]?.enabled
                        ? 'i-lucide-users-round'
                        : 'i-lucide-user'
                    "
                    :color="pipelines.draftConsensus[unit.index]?.enabled ? 'success' : 'neutral'"
                    variant="ghost"
                    size="xs"
                    :title="
                      pipelines.draftConsensus[unit.index]?.enabled
                        ? 'Consensus enabled — click to revert to a single agent'
                        : 'Enable consensus (multi-model panel/debate/voting) for this step'
                    "
                    @click="pipelines.toggleDraftConsensus(unit.index)"
                  />
                  <UButton
                    icon="i-lucide-chevron-up"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :disabled="vi === 0"
                    @click="pipelines.moveUnit(vi, vi - 1)"
                  />
                  <UButton
                    icon="i-lucide-chevron-down"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :disabled="vi === pipelines.units.length - 1"
                    @click="pipelines.moveUnit(vi, vi + 1)"
                  />
                  <UButton
                    icon="i-lucide-x"
                    color="error"
                    variant="ghost"
                    size="xs"
                    title="Remove this step from the pipeline"
                    @click="removeUnit(unit)"
                  />
                </div>
              </div>

              <!-- Attached companion: a dependent reviewer for this producer, optionally
                 gated on the task estimate. -->
              <div
                v-if="unit.companionIndex !== null"
                class="ml-6 space-y-2 rounded-md border border-fuchsia-800/40 bg-fuchsia-950/20 p-2 text-xs"
              >
                <div class="flex items-center gap-1.5">
                  <UIcon name="i-lucide-corner-down-right" class="h-3.5 w-3.5 text-slate-500" />
                  <AgentKindIcon
                    :kind="pipelines.draft[unit.companionIndex]!"
                    icon-class="h-4 w-4"
                  />
                  <span class="min-w-0 flex-1 truncate text-slate-200">
                    {{ agentKindMeta(pipelines.draft[unit.companionIndex]!).label }}
                  </span>
                  <UButton
                    :icon="
                      pipelines.draftGating[unit.companionIndex]?.enabled
                        ? 'i-lucide-toggle-right'
                        : 'i-lucide-toggle-left'
                    "
                    :color="
                      pipelines.draftGating[unit.companionIndex]?.enabled ? 'success' : 'neutral'
                    "
                    variant="ghost"
                    size="xs"
                    label="Gate on estimate"
                    title="Only run this companion when the task estimate clears a threshold (needs a Task Estimator earlier)"
                    @click="pipelines.toggleDraftGating(unit.companionIndex)"
                  />
                </div>
                <div
                  v-if="pipelines.draftGating[unit.companionIndex]?.enabled"
                  class="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-2"
                >
                  <span class="text-[10px] text-slate-500">run when (any):</span>
                  <label class="text-slate-400">complexity ≥</label>
                  <input
                    v-model.number="pipelines.draftGating[unit.companionIndex]!.minComplexity"
                    type="number"
                    min="0"
                    max="1"
                    step="0.1"
                    class="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-100"
                  />
                  <label class="text-slate-400">risk ≥</label>
                  <input
                    v-model.number="pipelines.draftGating[unit.companionIndex]!.minRisk"
                    type="number"
                    min="0"
                    max="1"
                    step="0.1"
                    class="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-100"
                  />
                  <label class="text-slate-400">impact ≥</label>
                  <input
                    v-model.number="pipelines.draftGating[unit.companionIndex]!.minImpact"
                    type="number"
                    min="0"
                    max="1"
                    step="0.1"
                    class="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-100"
                  />
                </div>
              </div>

              <!-- Consensus config (shown when the step is consensus-enabled). -->
              <div
                v-if="pipelines.draftConsensus[unit.index]?.enabled"
                class="ml-6 space-y-2 rounded-md border border-emerald-800/40 bg-emerald-950/20 p-2 text-xs"
              >
                <div class="flex items-center gap-2">
                  <label class="text-slate-400">Strategy</label>
                  <select
                    v-model="pipelines.draftConsensus[unit.index]!.strategy"
                    class="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-100"
                  >
                    <option v-for="s in CONSENSUS_STRATEGIES" :key="s.value" :value="s.value">
                      {{ s.label }}
                    </option>
                  </select>
                  <label
                    v-if="pipelines.draftConsensus[unit.index]!.strategy === 'debate'"
                    class="ml-2 text-slate-400"
                    >Rounds</label
                  >
                  <input
                    v-if="pipelines.draftConsensus[unit.index]!.strategy === 'debate'"
                    v-model.number="pipelines.draftConsensus[unit.index]!.rounds"
                    type="number"
                    min="1"
                    max="5"
                    placeholder="2"
                    class="w-12 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-100"
                  />
                </div>

                <!-- participants -->
                <div class="space-y-1">
                  <div
                    v-for="(p, pIdx) in pipelines.draftConsensus[unit.index]!.participants"
                    :key="p.id"
                    class="flex items-center gap-1.5"
                  >
                    <input
                      v-model="p.role"
                      placeholder="Role"
                      class="w-28 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-100"
                    />
                    <input
                      v-model="p.modelId"
                      placeholder="Model id (optional)"
                      class="flex-1 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-300"
                    />
                    <UButton
                      icon="i-lucide-x"
                      color="error"
                      variant="ghost"
                      size="xs"
                      :disabled="pipelines.draftConsensus[unit.index]!.participants.length <= 2"
                      title="Remove participant (min 2)"
                      @click="removeParticipant(unit.index, pIdx)"
                    />
                  </div>
                  <UButton
                    icon="i-lucide-plus"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    label="Add participant"
                    @click="addParticipant(unit.index)"
                  />
                </div>

                <!-- gating -->
                <div class="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-2">
                  <UButton
                    :icon="
                      pipelines.draftConsensus[unit.index]!.gating?.enabled
                        ? 'i-lucide-toggle-right'
                        : 'i-lucide-toggle-left'
                    "
                    :color="
                      pipelines.draftConsensus[unit.index]!.gating?.enabled ? 'success' : 'neutral'
                    "
                    variant="ghost"
                    size="xs"
                    label="Gate on estimate"
                    title="Only run consensus when the task estimate clears a threshold (else the standard agent runs)"
                    @click="toggleGating(unit.index)"
                  />
                  <template v-if="pipelines.draftConsensus[unit.index]!.gating?.enabled">
                    <label class="text-slate-400">risk ≥</label>
                    <input
                      v-model.number="pipelines.draftConsensus[unit.index]!.gating!.minRisk"
                      type="number"
                      min="0"
                      max="1"
                      step="0.1"
                      class="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-100"
                    />
                    <label class="text-slate-400">impact ≥</label>
                    <input
                      v-model.number="pipelines.draftConsensus[unit.index]!.gating!.minImpact"
                      type="number"
                      min="0"
                      max="1"
                      step="0.1"
                      class="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-slate-100"
                    />
                  </template>
                </div>
              </div>
            </li>
          </ol>

          <!-- Saved pipelines: review the library + delete (the run affordance
               moved to the task card / inspector when the palettes were removed). -->
          <div v-if="pipelines.pipelines.length" class="mt-4 border-t border-slate-800 pt-3">
            <div class="mb-2 flex items-center justify-between gap-2">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Saved pipelines
              </h3>
              <UButton
                v-if="archivedCount"
                :icon="showArchived ? 'i-lucide-archive-restore' : 'i-lucide-archive'"
                :color="showArchived ? 'primary' : 'neutral'"
                variant="ghost"
                size="xs"
                @click="showArchived = !showArchived"
              >
                {{ showArchived ? 'Hide archived' : `Archived (${archivedCount})` }}
              </UButton>
            </div>

            <!-- Label filter chips. -->
            <div v-if="allLabels.length" class="mb-2 flex flex-wrap items-center gap-1">
              <UBadge
                :color="labelFilter === null ? 'primary' : 'neutral'"
                variant="soft"
                size="xs"
                class="cursor-pointer"
                @click="labelFilter = null"
              >
                All
              </UBadge>
              <UBadge
                v-for="l in allLabels"
                :key="l"
                :color="labelFilter === l ? 'primary' : 'neutral'"
                variant="soft"
                size="xs"
                class="cursor-pointer"
                @click="labelFilter = labelFilter === l ? null : l"
              >
                {{ l }}
              </UBadge>
            </div>

            <ul class="space-y-1.5">
              <li
                v-for="p in visiblePipelines"
                :key="p.id"
                class="group rounded-lg border border-slate-700 bg-slate-800/40"
                :class="{ 'opacity-60': p.archived }"
              >
                <div class="flex items-center gap-2 px-2 py-1.5">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 text-left"
                    @click="toggleSaved(p.id)"
                  >
                    <UIcon
                      :name="
                        expandedSaved.has(p.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'
                      "
                      class="h-3.5 w-3.5 shrink-0 text-slate-500"
                    />
                    <span class="min-w-0 flex-1 truncate text-xs text-slate-200">{{ p.name }}</span>
                    <UBadge
                      v-for="l in p.labels ?? []"
                      :key="l"
                      color="info"
                      variant="soft"
                      size="xs"
                      class="shrink-0"
                    >
                      {{ l }}
                    </UBadge>
                    <UBadge
                      v-if="p.builtin"
                      color="neutral"
                      variant="soft"
                      size="xs"
                      class="shrink-0"
                    >
                      default
                    </UBadge>
                    <span class="shrink-0 text-[10px] text-slate-500">
                      {{ p.agentKinds.length }} {{ p.agentKinds.length === 1 ? 'step' : 'steps' }}
                    </span>
                  </button>
                  <div
                    class="flex shrink-0 items-center opacity-0 transition group-hover:opacity-100"
                  >
                    <!-- Archive/unarchive: organize the library without deleting. Works on
                         built-ins too (view metadata, not structure). -->
                    <UButton
                      :icon="p.archived ? 'i-lucide-archive-restore' : 'i-lucide-archive'"
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      :title="p.archived ? 'Unarchive' : 'Archive (hide from the default view)'"
                      @click="toggleArchive(p)"
                    />
                    <!-- Clone is available on every pipeline — it's how a read-only
                         built-in template becomes an editable copy. -->
                    <UButton
                      icon="i-lucide-copy"
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      :title="p.builtin ? 'Clone this default into an editable copy' : 'Clone'"
                      @click="clone(p)"
                    />
                    <!-- Built-in templates are read-only; only custom pipelines edit in place. -->
                    <UButton
                      v-if="!p.builtin"
                      icon="i-lucide-pencil"
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      title="Edit this pipeline"
                      @click="edit(p)"
                    />
                    <!-- Built-in templates are read-only — they can be cloned but not
                         deleted (the backend rejects it too); only custom ones delete. -->
                    <UButton
                      v-if="!p.builtin"
                      icon="i-lucide-trash-2"
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      @click="pipelines.removePipeline(p.id)"
                    />
                  </div>
                </div>

                <!-- Full ordered step list, revealed on click. -->
                <ol
                  v-if="expandedSaved.has(p.id)"
                  class="space-y-1 border-t border-slate-800 px-2 py-2 pl-7"
                >
                  <li
                    v-for="(k, i) in p.agentKinds"
                    :key="i"
                    class="flex items-center gap-2"
                    :class="{ 'opacity-50 line-through': p.enabled?.[i] === false }"
                    :title="p.enabled?.[i] === false ? 'Disabled — skipped at run' : undefined"
                  >
                    <span class="w-4 shrink-0 text-center text-[10px] text-slate-500">{{
                      i + 1
                    }}</span>
                    <AgentKindIcon :kind="k" show-label />
                  </li>
                </ol>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between">
        <UButton color="neutral" variant="ghost" size="sm" @click="pipelines.clearDraft()">
          {{ pipelines.editingId ? 'Cancel edit' : 'Clear' }}
        </UButton>
        <UButton
          color="primary"
          icon="i-lucide-save"
          size="sm"
          :disabled="pipelines.draft.length === 0"
          @click="save"
        >
          {{ pipelines.editingId ? 'Update pipeline' : 'Save pipeline' }}
        </UButton>
      </div>
    </template>
  </USlideover>

  <!-- Add-agent form -->
  <UModal v-model:open="addAgentOpen" title="Add agent">
    <template #body>
      <div class="space-y-3">
        <div>
          <label
            class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
          >
            Name
          </label>
          <UInput
            v-model="newAgentName"
            placeholder="e.g. Security Auditor"
            size="sm"
            class="w-full"
          />
        </div>
        <div>
          <label
            class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
          >
            Description
          </label>
          <UTextarea
            v-model="newAgentDesc"
            :rows="2"
            autoresize
            size="sm"
            class="w-full"
            placeholder="What does this agent do?"
          />
        </div>
        <UButton
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-file-text"
          block
          @click="placeholder('Link context document')"
        >
          Link context document
        </UButton>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <UButton color="neutral" variant="ghost" size="sm" @click="addAgentOpen = false">
          Cancel
        </UButton>
        <UButton
          color="primary"
          icon="i-lucide-plus"
          size="sm"
          :disabled="!newAgentName.trim()"
          @click="createAgent"
        >
          Create agent
        </UButton>
      </div>
    </template>
  </UModal>
</template>
