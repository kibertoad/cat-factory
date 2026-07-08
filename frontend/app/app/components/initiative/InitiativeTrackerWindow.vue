<script setup lang="ts">
// The initiative tracker window — the dedicated read-only view of an initiative's
// plan/tracker entity: goal + constraints, the phases with their per-item status +
// PR links, the execution policy, and the decisions / deviations / follow-ups /
// caveats logs. Renders the DB entity (the source of truth) — never the in-repo
// mirror, which may not exist (GitHub-unwired workspaces). Opened via the universal
// result-view host: from the board card / inspector (`ui.openInitiativeTracker`) or
// as the planner step's result view. Live `initiative` stream events patch the
// store, so an open window follows the plan as it is ingested and later executed.
import { computed, reactive, ref } from 'vue'
import type { InitiativeFollowUp, InitiativeItem } from '~/types/domain'
import {
  INITIATIVE_FOLLOWUP_STATUS_CHIPS,
  INITIATIVE_FOLLOWUP_STATUS_LABEL_KEYS,
  INITIATIVE_ITEM_STATUS_CHIPS,
  INITIATIVE_ITEM_STATUS_LABEL_KEYS,
  INITIATIVE_STATUS_LABEL_KEYS,
  initiativeProgress,
  pendingCheckpointPhase,
} from '~/utils/initiative'

const board = useBoardStore()
const initiatives = useInitiativesStore()
const { t } = useI18n()
const toast = useToast()

const { open, blockId, close } = useResultView('initiative-tracker', {
  onOpen: (id) => void initiatives.load(id),
})

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const initiative = computed(() => (blockId.value ? initiatives.forBlock(blockId.value) : null))

const phases = computed(() => initiative.value?.phases ?? [])
function itemsOf(phaseId: string): InitiativeItem[] {
  return (initiative.value?.items ?? []).filter((i) => i.phaseId === phaseId)
}

const progress = computed(() => initiativeProgress(initiative.value?.items))
const progressPct = computed(() =>
  progress.value && progress.value.total > 0
    ? Math.round((progress.value.settled / progress.value.total) * 100)
    : 0,
)

// Phase checkpoints (D2): the phase whose completed checkpoint is awaiting review (recomputed
// live from the entity — mirrors the loop's `pendingCheckpoint`), and whether the initiative is
// currently PAUSED at it. The tracker is the review surface: it shows the phase's committed
// artifacts + PRs, so a resume/cancel decision is taken right here.
const checkpointPhase = computed(() =>
  pendingCheckpointPhase(initiative.value?.phases, initiative.value?.items),
)
const pausedAtCheckpoint = computed(
  () => initiative.value?.status === 'paused' && checkpointPhase.value !== null,
)
// The phase whose checkpoint is genuinely holding the initiative RIGHT NOW (paused for review) —
// only then does its badge read "awaiting review". A phase whose items just settled but whose
// pause hasn't landed yet stays an upcoming checkpoint, so the badge can't get ahead of the banner.
const awaitingReviewPhaseId = computed(() =>
  pausedAtCheckpoint.value ? (checkpointPhase.value?.id ?? null) : null,
)

/** Resume (GO) or cancel (NO_GO) an initiative paused at a checkpoint. */
async function checkpointControl(action: 'resume' | 'cancel') {
  if (!blockId.value) return
  try {
    await initiatives.control(blockId.value, action)
  } catch (error) {
    reportError(error)
  }
}

const policyRules = computed(() => initiative.value?.policy?.rules ?? [])
function ruleAxes(rule: { minComplexity?: number; minRisk?: number; minImpact?: number }): string {
  const axes = [
    rule.minComplexity !== undefined
      ? t('initiative.tracker.axisComplexity', { value: rule.minComplexity })
      : null,
    rule.minRisk !== undefined ? t('initiative.tracker.axisRisk', { value: rule.minRisk }) : null,
    rule.minImpact !== undefined
      ? t('initiative.tracker.axisImpact', { value: rule.minImpact })
      : null,
  ].filter((a): a is string => a !== null)
  return axes.length ? axes.join(' · ') : t('initiative.tracker.axisNever')
}

// ---- Curation (slice 4): only meaningful while the initiative is still executing ----
const editable = computed(() => initiative.value?.status === 'executing')

/** Report a failed curation call as a toast (a stale-rev CAS conflict, an illegal edit, …). */
function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : t('initiative.curation.failed')
  toast.add({ title: t('initiative.curation.failed'), description: message, color: 'error' })
}

// Follow-up promotion: an inline per-follow-up form (phase + optional title override).
const promotingId = ref<string | null>(null)
const promoteForm = reactive<{ phaseId: string; title: string }>({ phaseId: '', title: '' })

function startPromote(followUp: InitiativeFollowUp) {
  const sourcePhase = (initiative.value?.items ?? []).find(
    (i) => i.id === followUp.sourceItemId,
  )?.phaseId
  promoteForm.phaseId = sourcePhase ?? phases.value[0]?.id ?? ''
  promoteForm.title = followUp.title
  promotingId.value = followUp.id
}

async function submitPromote(followUp: InitiativeFollowUp) {
  if (!initiative.value || !promoteForm.phaseId) return
  try {
    await initiatives.promoteFollowUp(initiative.value.id, followUp.id, {
      phaseId: promoteForm.phaseId,
      ...(promoteForm.title.trim() && promoteForm.title.trim() !== followUp.title
        ? { title: promoteForm.title.trim() }
        : {}),
    })
    promotingId.value = null
  } catch (error) {
    reportError(error)
  }
}

async function dismissFollowUp(followUp: InitiativeFollowUp) {
  if (!initiative.value) return
  try {
    await initiatives.dismissFollowUp(initiative.value.id, followUp.id)
  } catch (error) {
    reportError(error)
  }
}

// Item status control: retry a blocked item, or skip a pending/blocked one.
async function itemAction(item: InitiativeItem, action: 'retry' | 'skip') {
  if (!initiative.value) return
  try {
    await initiatives.updateItem(initiative.value.id, item.id, { action })
  } catch (error) {
    reportError(error)
  }
}

// Policy editing: retune the two scalar knobs (concurrency + default pipeline) while preserving
// the planner-authored rules. A full rule editor stays out of scope — re-plan to reshape rules.
const editingPolicy = ref(false)
const policyForm = reactive<{ maxConcurrent: number; defaultPipelineId: string }>({
  maxConcurrent: 1,
  defaultPipelineId: '',
})

function startEditPolicy() {
  const policy = initiative.value?.policy
  if (!policy) return
  policyForm.maxConcurrent = policy.maxConcurrent
  policyForm.defaultPipelineId = policy.defaultPipelineId
  editingPolicy.value = true
}

async function savePolicy() {
  const policy = initiative.value?.policy
  if (!initiative.value || !policy) return
  try {
    await initiatives.updatePolicy(initiative.value.id, {
      ...policy,
      maxConcurrent: policyForm.maxConcurrent,
      defaultPipelineId: policyForm.defaultPipelineId.trim() || policy.defaultPipelineId,
    })
    editingPolicy.value = false
  } catch (error) {
    reportError(error)
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex max-h-[100dvh] items-stretch justify-center bg-slate-950/70 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="m-4 flex w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
        role="dialog"
        aria-modal="true"
        data-testid="initiative-tracker-window"
      >
        <!-- Header -->
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300"
          >
            <UIcon name="i-lucide-milestone" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">
              {{ initiative?.title ?? block?.title ?? t('initiative.tracker.title') }}
            </h2>
            <p class="truncate text-[11px] text-slate-400">
              {{ t('initiative.tracker.subtitle') }}
            </p>
          </div>
          <div v-if="progress" class="flex items-center gap-2" data-testid="initiative-progress">
            <div class="h-1.5 w-24 overflow-hidden rounded-full bg-slate-800">
              <div
                class="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
                :style="{ width: `${progressPct}%` }"
              />
            </div>
            <span class="text-[11px] tabular-nums text-slate-400">
              {{ t('initiative.card.progress', { done: progress.settled, total: progress.total }) }}
            </span>
          </div>
          <UBadge v-if="initiative" color="primary" variant="subtle" size="sm">
            {{ t(INITIATIVE_STATUS_LABEL_KEYS[initiative.status]) }}
          </UBadge>
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <!-- No entity yet (module unwired / still creating) -->
          <div
            v-if="!initiative"
            class="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400"
          >
            <UIcon name="i-lucide-milestone" class="h-8 w-8 opacity-40" />
            <p class="text-sm">{{ t('initiative.tracker.empty') }}</p>
          </div>

          <template v-else>
            <!-- Paused at a phase checkpoint (D2): a completed checkpoint phase is awaiting
                 review before the next phase spawns. Read the phase's artifacts/PRs below,
                 then resume (continue) or cancel (stop) the initiative right here. -->
            <section
              v-if="pausedAtCheckpoint"
              class="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3.5"
              data-testid="initiative-checkpoint-pause"
            >
              <div class="flex items-start gap-2.5">
                <UIcon
                  name="i-lucide-pause-circle"
                  class="mt-0.5 h-4 w-4 shrink-0 text-amber-300"
                />
                <div class="min-w-0 flex-1">
                  <h3 class="text-[13px] font-semibold text-amber-200">
                    {{ t('initiative.checkpoint.pausedTitle') }}
                  </h3>
                  <p class="mt-0.5 text-[12px] leading-relaxed text-amber-100/80">
                    {{ t('initiative.checkpoint.pausedBody', { phase: checkpointPhase!.title }) }}
                  </p>
                  <div class="mt-2.5 flex flex-wrap gap-2">
                    <button
                      class="rounded bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                      :disabled="initiatives.controlling"
                      data-testid="initiative-checkpoint-resume"
                      @click="checkpointControl('resume')"
                    >
                      {{ t('initiative.inspector.resume') }}
                    </button>
                    <button
                      class="rounded border border-rose-500/50 px-2.5 py-1 text-[11px] font-medium text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
                      :disabled="initiatives.controlling"
                      data-testid="initiative-checkpoint-cancel"
                      @click="checkpointControl('cancel')"
                    >
                      {{ t('initiative.inspector.cancel') }}
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <!-- Goal & constraints -->
            <section v-if="initiative.goal" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.goal') }}
              </h3>
              <p class="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-300">
                {{ initiative.goal }}
              </p>
            </section>
            <section v-if="initiative.constraints?.length" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.constraints') }}
              </h3>
              <ul class="list-inside list-disc text-[13px] text-slate-300">
                <li v-for="(c, i) in initiative.constraints" :key="i">{{ c }}</li>
              </ul>
            </section>
            <section v-if="initiative.nonGoals?.length" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.nonGoals') }}
              </h3>
              <ul class="list-inside list-disc text-[13px] text-slate-300">
                <li v-for="(g, i) in initiative.nonGoals" :key="i">{{ g }}</li>
              </ul>
            </section>
            <section v-if="initiative.analysisSummary" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.analysis') }}
              </h3>
              <p class="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-300">
                {{ initiative.analysisSummary }}
              </p>
            </section>

            <!-- Awaiting planning -->
            <div
              v-if="phases.length === 0"
              class="mb-4 rounded-lg border border-dashed border-slate-700 p-4 text-center text-[12px] text-slate-400"
            >
              {{ t('initiative.tracker.noPlan') }}
            </div>

            <!-- Phases + items -->
            <section v-for="phase in phases" :key="phase.id" class="mb-5">
              <h3 class="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-200">
                <span>{{ t('initiative.tracker.phase', { title: phase.title }) }}</span>
                <!-- Checkpoint annotation (D2): this phase pauses the initiative for human review
                     once its items settle. Cleared → already reviewed; the pending one → awaiting
                     review; otherwise an upcoming gate. -->
                <UBadge
                  v-if="phase.checkpoint"
                  :color="
                    phase.checkpointClearedAt
                      ? 'neutral'
                      : awaitingReviewPhaseId === phase.id
                        ? 'warning'
                        : 'info'
                  "
                  variant="subtle"
                  size="sm"
                  :data-testid="`initiative-phase-checkpoint-${phase.id}`"
                >
                  <UIcon name="i-lucide-flag" class="mr-1 h-3 w-3" />
                  {{
                    phase.checkpointClearedAt
                      ? t('initiative.checkpoint.cleared')
                      : awaitingReviewPhaseId === phase.id
                        ? t('initiative.checkpoint.awaiting')
                        : t('initiative.checkpoint.badge')
                  }}
                </UBadge>
              </h3>
              <p v-if="phase.goal" class="mb-2 text-[12px] text-slate-400">{{ phase.goal }}</p>
              <div class="overflow-x-auto rounded-lg border border-slate-800">
                <table class="w-full text-[12px]">
                  <thead>
                    <tr class="border-b border-slate-800 text-left text-slate-500">
                      <th class="px-3 py-2 font-medium">{{ t('initiative.tracker.colItem') }}</th>
                      <th class="px-3 py-2 font-medium">{{ t('initiative.tracker.colStatus') }}</th>
                      <th class="px-3 py-2 font-medium">{{ t('initiative.tracker.colPr') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="item in itemsOf(phase.id)"
                      :key="item.id"
                      class="border-b border-slate-800/60 last:border-0"
                    >
                      <td class="px-3 py-2 align-top">
                        <div class="font-medium text-slate-200">{{ item.title }}</div>
                        <div
                          v-if="item.dependsOn?.length"
                          class="mt-0.5 text-[10px] text-slate-500"
                        >
                          {{
                            t('initiative.tracker.dependsOn', {
                              items: item.dependsOn.join(', '),
                            })
                          }}
                        </div>
                        <div v-if="item.note" class="mt-0.5 text-[10px] text-amber-300/80">
                          {{ item.note }}
                        </div>
                        <div
                          v-if="
                            editable && (item.status === 'blocked' || item.status === 'pending')
                          "
                          class="mt-1 flex gap-1.5"
                        >
                          <button
                            v-if="item.status === 'blocked'"
                            class="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                            :disabled="initiatives.curating"
                            :data-testid="`initiative-item-retry-${item.id}`"
                            @click="itemAction(item, 'retry')"
                          >
                            {{ t('initiative.curation.retry') }}
                          </button>
                          <button
                            class="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                            :disabled="initiatives.curating"
                            :data-testid="`initiative-item-skip-${item.id}`"
                            @click="itemAction(item, 'skip')"
                          >
                            {{ t('initiative.curation.skip') }}
                          </button>
                        </div>
                      </td>
                      <td class="px-3 py-2 align-top">
                        <UBadge
                          :color="INITIATIVE_ITEM_STATUS_CHIPS[item.status]"
                          variant="subtle"
                          size="sm"
                        >
                          {{ t(INITIATIVE_ITEM_STATUS_LABEL_KEYS[item.status]) }}
                        </UBadge>
                      </td>
                      <td class="px-3 py-2 align-top">
                        <a
                          v-if="item.pr"
                          :href="item.pr.url"
                          target="_blank"
                          rel="noopener"
                          class="text-sky-400 hover:underline"
                        >
                          {{
                            item.pr.number ? `#${item.pr.number}` : t('initiative.tracker.prLink')
                          }}
                        </a>
                        <span v-else class="text-slate-600">—</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <!-- Execution policy -->
            <section v-if="initiative.policy" class="mb-4">
              <div class="mb-1 flex items-center gap-2">
                <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {{ t('initiative.tracker.policy') }}
                </h3>
                <button
                  v-if="editable && !editingPolicy"
                  class="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                  data-testid="initiative-policy-edit"
                  @click="startEditPolicy"
                >
                  {{ t('initiative.curation.edit') }}
                </button>
              </div>
              <ul v-if="!editingPolicy" class="text-[12px] text-slate-300">
                <li>
                  {{
                    t('initiative.tracker.maxConcurrent', {
                      count: initiative.policy.maxConcurrent,
                    })
                  }}
                </li>
                <li v-for="(rule, i) in policyRules" :key="i">
                  <code class="text-sky-300">{{ rule.pipelineId }}</code>
                  · {{ ruleAxes(rule) }}
                </li>
                <li>
                  {{ t('initiative.tracker.defaultPipeline') }}
                  <code class="text-sky-300">{{ initiative.policy.defaultPipelineId }}</code>
                </li>
              </ul>
              <!-- Edit form: the two scalar knobs; planner-authored rules are preserved. -->
              <div v-else class="flex flex-col gap-2 rounded-lg border border-slate-800 p-3">
                <label class="flex items-center gap-2 text-[12px] text-slate-300">
                  <span class="w-40">{{ t('initiative.curation.maxConcurrentField') }}</span>
                  <input
                    v-model.number="policyForm.maxConcurrent"
                    type="number"
                    min="1"
                    max="20"
                    class="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
                    data-testid="initiative-policy-max-concurrent"
                  />
                </label>
                <label class="flex items-center gap-2 text-[12px] text-slate-300">
                  <span class="w-40">{{ t('initiative.curation.defaultPipelineField') }}</span>
                  <input
                    v-model="policyForm.defaultPipelineId"
                    type="text"
                    class="flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200"
                    data-testid="initiative-policy-default-pipeline"
                  />
                </label>
                <div class="flex gap-2">
                  <button
                    class="rounded bg-indigo-600 px-2 py-1 text-[11px] text-white hover:bg-indigo-500 disabled:opacity-50"
                    :disabled="initiatives.curating"
                    data-testid="initiative-policy-save"
                    @click="savePolicy"
                  >
                    {{ t('initiative.curation.save') }}
                  </button>
                  <button
                    class="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                    @click="editingPolicy = false"
                  >
                    {{ t('initiative.curation.cancel') }}
                  </button>
                </div>
              </div>
            </section>

            <!-- Logs -->
            <section v-if="initiative.decisions?.length" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.decisions') }}
              </h3>
              <ul class="list-inside list-disc text-[13px] text-slate-300">
                <li v-for="d in initiative.decisions" :key="d.id">
                  <span class="font-medium">{{ d.title }}</span>
                  <span v-if="d.detail" class="text-slate-400"> — {{ d.detail }}</span>
                </li>
              </ul>
            </section>
            <section v-if="initiative.deviations?.length" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.deviations') }}
              </h3>
              <ul class="list-inside list-disc text-[13px] text-slate-300">
                <li v-for="d in initiative.deviations" :key="d.id">
                  <code v-if="d.itemId" class="text-slate-400">{{ d.itemId }}</code>
                  {{ d.description }}
                  <span v-if="d.resolution" class="text-slate-400"> → {{ d.resolution }}</span>
                </li>
              </ul>
            </section>
            <section v-if="initiative.followUps?.length" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.followUps') }}
              </h3>
              <ul class="flex flex-col gap-2 text-[13px] text-slate-300">
                <li
                  v-for="f in initiative.followUps"
                  :key="f.id"
                  class="rounded-lg border border-slate-800 p-2.5"
                  :data-testid="`initiative-followup-${f.id}`"
                >
                  <div class="flex items-start gap-2">
                    <div class="min-w-0 flex-1">
                      <span class="font-medium">{{ f.title }}</span>
                      <span v-if="f.detail" class="text-slate-400"> — {{ f.detail }}</span>
                    </div>
                    <UBadge
                      :color="INITIATIVE_FOLLOWUP_STATUS_CHIPS[f.status]"
                      variant="subtle"
                      size="sm"
                    >
                      {{ t(INITIATIVE_FOLLOWUP_STATUS_LABEL_KEYS[f.status]) }}
                    </UBadge>
                  </div>
                  <!-- Triage actions for an open follow-up (only while executing) -->
                  <div v-if="editable && f.status === 'open'" class="mt-2">
                    <div v-if="promotingId === f.id" class="flex flex-col gap-2">
                      <label class="flex items-center gap-2 text-[12px]">
                        <span class="text-slate-400">{{
                          t('initiative.curation.phaseField')
                        }}</span>
                        <select
                          v-model="promoteForm.phaseId"
                          class="flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
                          data-testid="initiative-promote-phase"
                        >
                          <option v-for="p in phases" :key="p.id" :value="p.id">
                            {{ p.title }}
                          </option>
                        </select>
                      </label>
                      <input
                        v-model="promoteForm.title"
                        type="text"
                        class="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[12px] text-slate-200"
                        :placeholder="t('initiative.curation.itemTitlePlaceholder')"
                        data-testid="initiative-promote-title"
                      />
                      <div class="flex gap-2">
                        <button
                          class="rounded bg-indigo-600 px-2 py-1 text-[11px] text-white hover:bg-indigo-500 disabled:opacity-50"
                          :disabled="initiatives.curating || !promoteForm.phaseId"
                          data-testid="initiative-promote-submit"
                          @click="submitPromote(f)"
                        >
                          {{ t('initiative.curation.promoteConfirm') }}
                        </button>
                        <button
                          class="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                          @click="promotingId = null"
                        >
                          {{ t('initiative.curation.cancel') }}
                        </button>
                      </div>
                    </div>
                    <div v-else class="flex gap-1.5">
                      <button
                        class="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
                        data-testid="initiative-followup-promote"
                        @click="startPromote(f)"
                      >
                        {{ t('initiative.curation.promote') }}
                      </button>
                      <button
                        class="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                        :disabled="initiatives.curating"
                        data-testid="initiative-followup-dismiss"
                        @click="dismissFollowUp(f)"
                      >
                        {{ t('initiative.curation.dismiss') }}
                      </button>
                    </div>
                  </div>
                </li>
              </ul>
            </section>
            <section v-if="initiative.caveats?.length" class="mb-4">
              <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {{ t('initiative.tracker.caveats') }}
              </h3>
              <ul class="list-inside list-disc text-[13px] text-slate-300">
                <li v-for="(c, i) in initiative.caveats" :key="i">{{ c }}</li>
              </ul>
            </section>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
