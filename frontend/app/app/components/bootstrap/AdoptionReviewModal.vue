<script setup lang="ts">
// The human review a monorepo bootstrap parks on: for each convention area the platform
// surveyed, the reviewer decides whether the new service follows the surrounding monorepo or
// keeps what the reference template ships.
//
// The whole point of this surface is that a suggestion is CHECKABLE, so it renders the evidence
// (the files each recommendation was read from) beside every line, and never shows a decision
// as answered until the reviewer has actually answered it. It also renders the case where there
// is no suggestion at all as its own state, because "the two repositories agreed on everything"
// and "the analysis never ran" would otherwise look identical and lead to opposite conclusions.
import type { AdoptionSource, BootstrapJob } from '~/types/domain'

const props = defineProps<{ job: BootstrapJob }>()
const emit = defineEmits<{ close: [] }>()

const agentRuns = useAgentRunsStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { t } = useI18n()

const open = ref(true)
const submitting = ref(false)

const plan = computed(() => props.job.adoptionPlan)
const decisions = computed(() => plan.value?.decisions ?? [])
const unavailable = computed(() => plan.value?.status !== 'ready')

/** The reviewer's answers, keyed by decision id; seeded from the recommendations. */
const choices = ref<Record<string, AdoptionSource>>({})
const notes = ref<Record<string, string>>({})
const overallNotes = ref('')

// Seeding from the recommendation is a starting POINT, not an answer: `touched` is what tracks
// whether a human has looked at each line, and the submit button waits for all of them. Without
// it, pre-selecting the suggestion would make "approve" mean nothing.
const touched = ref<Set<string>>(new Set())

/**
 * What the reviewer is answering, as an identity rather than as an object.
 *
 * The watcher below RESETS every answer, so what it keys on decides when a reviewer's work is
 * thrown away. `decisions` is a computed array, so it is a fresh reference every time the store
 * upserts a re-parsed job for this block, which any live `bootstrap` event or debounced board
 * refresh does, including ones about other runs. Keying on it wiped a half-finished 10-decision
 * review, silently reverting every override, while leaving the per-decision notes attached to
 * re-seeded recommendations they were never written for.
 */
const planIdentity = computed(() => `${props.job.id}:${plan.value?.generatedAt ?? 0}`)

watch(
  planIdentity,
  () => {
    const seeded: Record<string, AdoptionSource> = {}
    for (const decision of decisions.value) seeded[decision.id] = decision.recommended
    choices.value = seeded
    // Reset WITH the choices, never after them: a note left beside a re-seeded recommendation
    // reads as an instruction the reviewer gave for a decision they no longer made.
    notes.value = {}
    touched.value = new Set()
  },
  { immediate: true },
)

const sourceItems = computed(() =>
  (['monorepo', 'template', 'both', 'neither'] as const).map((value) => ({
    label: t(`bootstrap.adoption.source.${value}`),
    value,
  })),
)

function choose(id: string, value: AdoptionSource) {
  choices.value[id] = value
  touched.value = new Set([...touched.value, id])
}

/** Accept every recommendation at once, which is still an explicit act by the reviewer. */
function acceptAll() {
  touched.value = new Set(decisions.value.map((d) => d.id))
}

const remaining = computed(() => decisions.value.filter((d) => !touched.value.has(d.id)).length)
// An unavailable plan carries no decisions, so there is nothing to answer and nothing to wait
// for: submitting it is the reviewer saying "go ahead, I am deciding this unaided", which is the
// only exit from the park. Disabling it here left a deployment with no adoption model unable to
// finish a monorepo bootstrap at all.
const canSubmit = computed(() => remaining.value === 0)

/**
 * What the survey actually read, for the disclosure beside the plan.
 *
 * Shown at all because the evidence set is no longer something the platform declared in advance:
 * the model chose most of it, so "what was this suggestion built from" is a question only the
 * transcript answers. Split by ORIGIN, because a reviewer weighing a thin plan needs to know
 * whether the read was thin or the reading was.
 *
 * `reads` is nullable because the list projection withholds the transcript once a run is past its
 * review, and this modal opens only for a run that is still awaiting one, which is exactly the
 * case the projection keeps. So the fallback below is unreachable rather than a silent default.
 */
const surveyReads = computed(() => plan.value?.survey.reads ?? [])
const readSummary = computed(() => ({
  read: surveyReads.value.filter((entry) => entry.outcome === 'read').length,
  byModel: surveyReads.value.filter((entry) => entry.origin === 'model' && entry.outcome === 'read')
    .length,
  missed: surveyReads.value.filter((entry) => entry.outcome !== 'read').length,
}))

/**
 * How many reads the transcript could not hold.
 *
 * The summary above counts the ARRAY, which is capped, so a survey that made 140 reads and kept
 * 96 would otherwise read as a survey that made 96. Shown for the same reason `exhausted` is: a
 * record with a missing tail and a complete one lead a reviewer to opposite conclusions about how
 * much of the monorepo this suggestion was built from.
 */
const recordsDropped = computed(() => plan.value?.survey.exploration.recordsDropped ?? 0)

/**
 * Which budget the exploration ran out of, or null when it did not.
 *
 * Surfaced rather than left in the transcript: a survey that stopped because the model had seen
 * enough and one that stopped at a ceiling look identical in a list of paths, and only the second
 * means the plan may be missing areas nobody decided not to look at.
 */
const exhausted = computed(() => plan.value?.survey.exploration.exhausted ?? null)

/** The monorepo this service is landing in, for the header line. */
const target = computed(() => {
  const monorepo = props.job.monorepo
  return monorepo ? `${monorepo.repoOwner}/${monorepo.repoName}` : ''
})

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    // Derived from the PLAN's decisions, so an unavailable plan sends an empty set: the server
    // refuses answers naming decisions the plan does not carry, which is what makes a review
    // submitted against a re-surveyed plan fail loudly instead of applying half of it.
    await agentRuns.submitAdoptionReview(props.job.id, {
      choices: decisions.value.map((decision) => ({
        id: decision.id,
        choice: choices.value[decision.id] ?? decision.recommended,
        ...(notes.value[decision.id]?.trim() ? { note: notes.value[decision.id]!.trim() } : {}),
      })),
      ...(overallNotes.value.trim() ? { notes: overallNotes.value.trim() } : {}),
    })
    toast.add({
      title: t('bootstrap.adoption.toast.approved'),
      description: t('bootstrap.adoption.toast.approvedDesc', {
        directory: props.job.monorepo?.directory ?? '',
      }),
      icon: 'i-lucide-check',
      color: 'success',
    })
    open.value = false
    emit('close')
  } catch (e) {
    present(e, 'bootstrap.adoption.toast.failed')
  } finally {
    submitting.value = false
  }
}

watch(open, (isOpen) => {
  if (!isOpen) emit('close')
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('bootstrap.adoption.title')"
    :description="
      t('bootstrap.adoption.subtitle', { target, directory: job.monorepo?.directory ?? '' })
    "
    :ui="{ content: 'max-w-3xl' }"
  >
    <template #body>
      <div class="space-y-5">
        <!-- No suggestion: state WHY, and let the reviewer proceed unaided rather than
             presenting an empty list, which would read as "there was nothing to decide". -->
        <div
          v-if="unavailable"
          class="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
        >
          <div class="flex items-start gap-2">
            <UIcon name="i-lucide-triangle-alert" class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p class="text-sm text-amber-200/90">
              {{
                t(
                  `bootstrap.adoption.unavailable.${plan?.unavailableReason ?? 'analysis_unusable'}`,
                )
              }}
            </p>
          </div>
          <p v-if="plan?.unavailableDetail" class="pl-6 text-xs text-slate-400">
            {{ plan.unavailableDetail }}
          </p>
        </div>

        <!-- What the survey read, on BOTH paths. The model chose most of the evidence set, so
             "what was this built from" is a question only the transcript answers, and an
             exhausted budget is called out rather than left for someone to infer from a short
             list: it is the difference between a thin read and a thin reading. -->
        <div v-if="surveyReads.length" class="space-y-2 text-xs">
          <p class="text-slate-400">
            {{
              t('bootstrap.adoption.survey.summary', {
                read: readSummary.read,
                byModel: readSummary.byModel,
              })
            }}
          </p>
          <p v-if="readSummary.missed > 0" class="text-slate-500">
            {{ t('bootstrap.adoption.survey.missed', { count: readSummary.missed }) }}
          </p>
          <p v-if="exhausted" class="text-amber-300/90">
            {{ t(`bootstrap.adoption.survey.exhausted.${exhausted}`) }}
          </p>
          <p v-if="recordsDropped > 0" class="text-amber-300/90">
            {{ t('bootstrap.adoption.survey.truncated', { count: recordsDropped }) }}
          </p>
          <details>
            <summary class="cursor-pointer text-slate-500 hover:text-slate-300">
              {{ t('bootstrap.adoption.survey.show') }}
            </summary>
            <ul class="mt-2 space-y-1">
              <!-- Keyed by POSITION: the transcript is append-only and rendered in order, and
                   the same path legitimately appears twice (a body refused by the seed and then
                   served to the model, a path the model retried). Keying on the path patched
                   those two rows against each other and rendered a note beside the wrong one. -->
              <li
                v-for="(entry, index) in surveyReads"
                :key="index"
                class="flex items-baseline gap-2"
              >
                <span
                  class="shrink-0 font-mono text-[10px] uppercase"
                  :class="entry.outcome === 'read' ? 'text-slate-500' : 'text-amber-400/80'"
                >
                  {{ t(`bootstrap.adoption.survey.outcome.${entry.outcome}`) }}
                </span>
                <span class="font-mono text-slate-400">{{ entry.path }}</span>
                <span v-if="entry.note" class="text-slate-600">{{ entry.note }}</span>
              </li>
            </ul>
          </details>
        </div>

        <!-- The reviewer's own instructions, on BOTH paths. With no suggestion to answer this is
             the only thing they can say, and it reaches the agent's brief verbatim. -->
        <UFormField
          v-if="unavailable"
          :label="t('bootstrap.adoption.notes.label')"
          :description="t('bootstrap.adoption.notes.unavailableDescription')"
        >
          <UTextarea v-model="overallNotes" :rows="3" class="w-full" />
        </UFormField>

        <template v-else>
          <div class="flex items-center justify-between gap-3">
            <p class="text-sm text-slate-400">{{ t('bootstrap.adoption.intro') }}</p>
            <UButton
              color="neutral"
              variant="subtle"
              size="xs"
              icon="i-lucide-check-check"
              @click="acceptAll"
            >
              {{ t('bootstrap.adoption.acceptAll') }}
            </UButton>
          </div>

          <ul class="space-y-3">
            <li
              v-for="decision in decisions"
              :key="decision.id"
              class="space-y-3 rounded-md border p-3"
              :class="
                touched.has(decision.id)
                  ? 'border-slate-700 bg-slate-900/40'
                  : 'border-amber-500/40 bg-amber-500/5'
              "
            >
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="text-sm font-medium text-slate-100">{{ decision.title }}</p>
                  <p class="text-[11px] uppercase tracking-wide text-slate-500">
                    {{ t(`bootstrap.adoption.area.${decision.area}`) }}
                  </p>
                </div>
                <UBadge v-if="!touched.has(decision.id)" color="warning" variant="subtle" size="sm">
                  {{ t('bootstrap.adoption.needsYou') }}
                </UBadge>
              </div>

              <div class="grid gap-2 text-xs sm:grid-cols-2">
                <div class="rounded bg-slate-900/60 p-2">
                  <p class="mb-1 font-semibold text-slate-300">
                    {{ t('bootstrap.adoption.side.monorepo') }}
                  </p>
                  <p class="text-slate-400">
                    {{ decision.monorepoPractice ?? t('bootstrap.adoption.side.nothing') }}
                  </p>
                </div>
                <div class="rounded bg-slate-900/60 p-2">
                  <p class="mb-1 font-semibold text-slate-300">
                    {{ t('bootstrap.adoption.side.template') }}
                  </p>
                  <p class="text-slate-400">
                    {{ decision.templatePractice ?? t('bootstrap.adoption.side.nothing') }}
                  </p>
                </div>
              </div>

              <p class="text-xs text-slate-400">{{ decision.rationale }}</p>

              <!-- The evidence is what makes the suggestion checkable rather than an assertion,
                   so it is shown, not tucked away. -->
              <p v-if="decision.evidence.length" class="text-[11px] text-slate-500">
                {{ t('bootstrap.adoption.evidence') }}
                <span class="font-mono">{{ decision.evidence.join(', ') }}</span>
              </p>

              <div class="flex flex-wrap items-center gap-2">
                <UButton
                  v-for="item in sourceItems"
                  :key="item.value"
                  size="xs"
                  :color="choices[decision.id] === item.value ? 'primary' : 'neutral'"
                  :variant="choices[decision.id] === item.value ? 'solid' : 'subtle'"
                  @click="choose(decision.id, item.value)"
                >
                  {{ item.label }}
                </UButton>
                <UBadge
                  v-if="choices[decision.id] !== decision.recommended"
                  color="info"
                  variant="subtle"
                  size="sm"
                >
                  {{ t('bootstrap.adoption.overridden') }}
                </UBadge>
              </div>

              <UInput
                v-model="notes[decision.id]"
                size="sm"
                :placeholder="t('bootstrap.adoption.notePlaceholder')"
                class="w-full"
              />
            </li>
          </ul>

          <UFormField
            :label="t('bootstrap.adoption.notes.label')"
            :description="t('bootstrap.adoption.notes.description')"
          >
            <UTextarea v-model="overallNotes" :rows="3" class="w-full" />
          </UFormField>
        </template>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-3">
        <p v-if="!unavailable && remaining > 0" class="text-xs text-amber-300/90">
          {{ t('bootstrap.adoption.remaining', { count: remaining }) }}
        </p>
        <span v-else />
        <div class="flex items-center gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="primary"
            icon="i-lucide-play"
            :loading="submitting"
            :disabled="!canSubmit"
            @click="submit"
          >
            {{ t('bootstrap.adoption.approve') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
