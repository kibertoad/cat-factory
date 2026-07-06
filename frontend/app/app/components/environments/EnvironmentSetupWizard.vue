<script setup lang="ts">
// The environment setup wizard (shared-stacks slice 7): a guided detect → review → preflight →
// save flow that configures a service frame's `docker-compose` provisioning so the SINGLE Deployer
// step provisions it (recipe execution + shared stacks + preflights), and the Tester targets the
// resulting env. All cross-step state + actions live in `useEnvironmentWizardStore`; this component
// is the presentation shell. On save it registers the workspace's `docker-compose` handler AND
// writes the recipe onto the frame, then optionally trial-provisions with live logs.
import { computed, ref, watch } from 'vue'
import type {
  MergeableRecipeField,
  ProvisioningComposeFileCandidate,
  ProvisioningProfileCandidate,
  ProvisioningSeedDumpCandidate,
} from '@cat-factory/contracts'
import ProvisioningLogsDrawer from '~/components/provisioning/ProvisioningLogsDrawer.vue'

const ui = useUiStore()
const store = useEnvironmentWizardStore()
const preflights = usePreflightsStore()
const { t } = useI18n()

// The host-probe runtime isn't wired (a non-local facade 503'd) — the checklist degrades to a note.
const preflightsUnavailable = computed(() => preflights.available === false)

const open = computed({
  get: () => ui.environmentWizardOpen,
  set: (v: boolean) => {
    if (!v) ui.closeEnvironmentSetup()
  },
})

// Reset + (re)seed the flow whenever the modal opens, honouring the frame the launcher preselected.
watch(
  open,
  (isOpen) => {
    if (isOpen) store.open(ui.environmentWizardFrameId)
  },
  { immediate: true },
)

// ---- Stepper header ---------------------------------------------------------
const STEP_ORDER = ['pick', 'review', 'preflight', 'save'] as const
type Step = (typeof STEP_ORDER)[number]
const STEP_LABEL = computed<Record<Step, string>>(() => ({
  pick: t('environmentWizard.steps.pick'),
  review: t('environmentWizard.steps.review'),
  preflight: t('environmentWizard.steps.preflight'),
  save: t('environmentWizard.steps.save'),
}))
const currentIndex = computed(() => STEP_ORDER.indexOf(store.step as Step))

// ---- Provenance -------------------------------------------------------------
const FIELD_LABEL = computed<Record<MergeableRecipeField, string>>(() => ({
  composeFiles: t('environmentWizard.field.composeFiles'),
  composeProfiles: t('environmentWizard.field.composeProfiles'),
  envFiles: t('environmentWizard.field.envFiles'),
  externalNetworks: t('environmentWizard.field.externalNetworks'),
  sharedStackRefs: t('environmentWizard.field.sharedStackRefs'),
  prerequisites: t('environmentWizard.field.prerequisites'),
  setupSteps: t('environmentWizard.field.setupSteps'),
  healthGate: t('environmentWizard.field.healthGate'),
  teardownSteps: t('environmentWizard.field.teardownSteps'),
}))
const ORIGIN_COLOR: Record<'detector' | 'analyst' | 'both', 'success' | 'info' | 'warning'> = {
  detector: 'success',
  analyst: 'info',
  both: 'warning',
}
const ORIGIN_LABEL = computed<Record<'detector' | 'analyst' | 'both', string>>(() => ({
  detector: t('environmentWizard.origin.detector'),
  analyst: t('environmentWizard.origin.analyst'),
  both: t('environmentWizard.origin.both'),
}))

// ---- Candidate helpers ------------------------------------------------------
const composeFileCandidates = computed<ProvisioningComposeFileCandidate[]>(
  () => store.recommendation?.composeFileCandidates ?? [],
)
const profileCandidates = computed<ProvisioningProfileCandidate[]>(
  () => store.recommendation?.profileCandidates ?? [],
)
const seedDumpCandidates = computed<ProvisioningSeedDumpCandidate[]>(
  () => store.recommendation?.seedDumpCandidates ?? [],
)
const composeServiceOptions = computed(() =>
  (store.recommendation?.composeServiceCandidates ?? []).map((c) => ({
    label: c.recommended ? `${c.service} · ${t('environmentWizard.recommended')}` : c.service,
    value: c.service,
  })),
)
// The repo ships its own imperative bring-up (a `bin/*console*` / Makefile / justfile the
// deterministic scan can't read) — the strongest signal to run the analyst, so when present we
// elevate the deep-analysis affordance from a quiet opt-in to a prominent nudge naming the CLI.
const repoCliHint = computed(() => store.recommendation?.repoCliHint)

function fileEnabled(path: string): boolean {
  return store.recipe.composeFiles?.includes(path) ?? false
}
function profileEnabled(profile: string): boolean {
  return store.recipe.composeProfiles?.includes(profile) ?? false
}
function seedAdded(path: string): boolean {
  return (store.recipe.setupSteps ?? []).some(
    (s) => s.kind === 'compose-exec' && s.stdinFile === path,
  )
}

// ---- Raw recipe editor ------------------------------------------------------
const rawOpen = ref(false)
const rawText = ref('')
const rawError = ref<string | null>(null)
function openRaw() {
  rawText.value = JSON.stringify(store.recipe, null, 2)
  rawError.value = null
  rawOpen.value = true
}
function toggleRaw() {
  if (rawOpen.value) rawOpen.value = false
  else openRaw()
}
function applyRaw() {
  rawError.value = store.setRecipeFromJson(rawText.value)
  if (!rawError.value) rawOpen.value = false
}

// ---- Preflight verdict presentation -----------------------------------------
const PREFLIGHT_COLOR: Record<'pass' | 'warn' | 'fail', 'success' | 'warning' | 'error'> = {
  pass: 'success',
  warn: 'warning',
  fail: 'error',
}

// ---- Step navigation --------------------------------------------------------
const canLeaveReview = computed(
  () => !!store.recommendation && store.composeService.trim().length > 0,
)
function back() {
  const idx = currentIndex.value
  if (idx > 0) store.goToStep(STEP_ORDER[idx - 1]!)
}
function next() {
  const idx = currentIndex.value
  if (idx < STEP_ORDER.length - 1) store.goToStep(STEP_ORDER[idx + 1]!)
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('environmentWizard.title')"
    :description="t('environmentWizard.subtitle')"
    :ui="{ content: 'max-w-3xl' }"
  >
    <template #body>
      <div class="space-y-5" data-testid="env-setup-wizard">
        <!-- stepper header -->
        <ol class="flex items-center gap-2 text-[11px]">
          <li
            v-for="(s, i) in STEP_ORDER"
            :key="s"
            class="flex items-center gap-2"
            :data-testid="`env-setup-crumb-${s}`"
          >
            <span
              class="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold"
              :class="
                i === currentIndex
                  ? 'bg-primary-500 text-white'
                  : i < currentIndex
                    ? 'bg-emerald-600/70 text-white'
                    : 'bg-slate-700 text-slate-300'
              "
              >{{ i + 1 }}</span
            >
            <span :class="i === currentIndex ? 'text-slate-100' : 'text-slate-500'">
              {{ STEP_LABEL[s] }}
            </span>
            <UIcon
              v-if="i < STEP_ORDER.length - 1"
              name="i-lucide-chevron-right"
              class="h-3 w-3 text-slate-600"
            />
          </li>
        </ol>

        <!-- ============================ PICK ============================ -->
        <section v-if="store.step === 'pick'" class="space-y-3" data-testid="env-setup-step-pick">
          <p class="text-sm text-slate-400">{{ t('environmentWizard.pick.intro') }}</p>
          <p v-if="!store.serviceFrames.length" class="text-sm text-slate-500">
            {{ t('environmentWizard.pick.empty') }}
          </p>
          <div v-else class="space-y-1.5">
            <UButton
              v-for="frame in store.serviceFrames"
              :key="frame.id"
              block
              color="neutral"
              variant="soft"
              class="justify-start"
              icon="i-lucide-box"
              :data-testid="`env-setup-frame-${frame.id}`"
              @click="store.selectFrame(frame.id)"
            >
              {{ frame.title }}
            </UButton>
          </div>
        </section>

        <!-- =========================== REVIEW =========================== -->
        <section
          v-else-if="store.step === 'review'"
          class="space-y-4"
          data-testid="env-setup-step-review"
        >
          <!-- detection status -->
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-medium text-slate-200">{{ store.targetFrame?.title }}</p>
              <p class="text-[11px] text-slate-500">
                {{ t('environmentWizard.review.detectHint') }}
              </p>
            </div>
            <UButton
              size="xs"
              variant="soft"
              color="primary"
              icon="i-lucide-wand-sparkles"
              :loading="store.detecting"
              :disabled="!store.hasRepo"
              data-testid="env-setup-detect"
              @click="store.detect()"
            >
              {{ t('environmentWizard.review.detect') }}
            </UButton>
          </div>

          <p v-if="!store.hasRepo" class="text-[12px] text-amber-300/80">
            {{ t('environmentWizard.review.noRepo') }}
          </p>
          <p
            v-else-if="store.detectError"
            class="text-[12px] text-rose-300/80"
            data-testid="env-setup-detect-error"
          >
            {{ t('environmentWizard.review.detectError') }}
          </p>

          <template v-if="store.recommendation && !store.detecting">
            <!-- deep analysis (opt-in; elevated to a prominent nudge when the repo ships its own CLI) -->
            <div
              class="rounded-md border p-3"
              :class="
                repoCliHint
                  ? 'border-primary-700/60 bg-primary-950/30'
                  : 'border-slate-800 bg-slate-900/40'
              "
            >
              <p
                v-if="repoCliHint"
                class="mb-2 flex items-start gap-1.5 text-[11px] text-primary-300"
                data-testid="env-setup-cli-nudge"
              >
                <UIcon name="i-lucide-lightbulb" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{{
                  t('environmentWizard.analysis.cliNudge', { path: repoCliHint.path })
                }}</span>
              </p>
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <p class="text-[12px] font-medium text-slate-300">
                    {{ t('environmentWizard.analysis.title') }}
                  </p>
                  <p class="text-[11px] text-slate-500">
                    {{ t('environmentWizard.analysis.hint') }}
                  </p>
                </div>
                <UButton
                  size="xs"
                  variant="soft"
                  :color="repoCliHint ? 'primary' : 'neutral'"
                  icon="i-lucide-sparkles"
                  :loading="store.analysisStatus === 'running'"
                  :disabled="!store.canAnalyze || store.analysisStatus === 'running'"
                  data-testid="env-setup-run-analysis"
                  @click="store.startAnalysis()"
                >
                  {{ t('environmentWizard.analysis.run') }}
                </UButton>
              </div>
              <p
                v-if="!store.canAnalyze"
                class="mt-2 text-[11px] text-slate-500"
                data-testid="env-setup-analysis-unavailable"
              >
                {{ t('environmentWizard.analysis.unavailable') }}
              </p>
              <p
                v-else-if="store.analysisStatus === 'failed'"
                class="mt-2 text-[11px] text-rose-300/80"
              >
                {{ t('environmentWizard.analysis.failed') }}
              </p>
              <div
                v-else-if="store.analysisStatus === 'ready'"
                class="mt-2 space-y-2"
                data-testid="env-setup-analysis-ready"
              >
                <p v-if="store.merged?.summary" class="text-[11px] leading-snug text-slate-400">
                  {{ store.merged.summary }}
                </p>
                <UButton
                  size="xs"
                  variant="soft"
                  color="primary"
                  icon="i-lucide-git-merge"
                  data-testid="env-setup-apply-analysis"
                  @click="store.applyAnalystDraft()"
                >
                  {{ t('environmentWizard.analysis.apply') }}
                </UButton>
              </div>
            </div>

            <!-- per-field provenance -->
            <div v-if="store.merged?.fields.length" class="space-y-1.5">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {{ t('environmentWizard.review.provenanceTitle') }}
              </p>
              <div class="flex flex-wrap gap-1.5">
                <UBadge
                  v-for="f in store.merged.fields"
                  :key="f.field"
                  :color="ORIGIN_COLOR[f.origin]"
                  variant="subtle"
                  size="sm"
                  :title="f.detectorMessage ?? f.analystRationale ?? ''"
                  :data-testid="`env-setup-field-${f.field}`"
                >
                  {{ FIELD_LABEL[f.field] }} · {{ ORIGIN_LABEL[f.origin] }}
                </UBadge>
              </div>
            </div>

            <!-- exposed compose service + port -->
            <div class="grid grid-cols-2 gap-3">
              <UFormField :label="t('environmentWizard.review.service')" required>
                <USelect
                  v-if="composeServiceOptions.length"
                  v-model="store.composeService"
                  :items="composeServiceOptions"
                  value-key="value"
                  :placeholder="t('environmentWizard.review.servicePlaceholder')"
                  class="w-full"
                  data-testid="env-setup-service-select"
                />
                <UInput
                  v-else
                  v-model="store.composeService"
                  :placeholder="t('environmentWizard.review.servicePlaceholder')"
                  class="w-full"
                  data-testid="env-setup-service-input"
                />
              </UFormField>
              <UFormField :label="t('environmentWizard.review.port')">
                <UInput
                  v-model.number="store.exposedPort"
                  type="number"
                  class="w-full"
                  data-testid="env-setup-port"
                />
              </UFormField>
            </div>

            <!-- compose file layering -->
            <div v-if="composeFileCandidates.length" class="space-y-1.5">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {{ t('environmentWizard.review.composeFiles') }}
              </p>
              <div class="flex flex-wrap gap-1.5">
                <UButton
                  v-for="c in composeFileCandidates"
                  :key="c.path"
                  size="xs"
                  :color="fileEnabled(c.path) ? 'primary' : 'neutral'"
                  :variant="fileEnabled(c.path) ? 'soft' : 'ghost'"
                  :icon="fileEnabled(c.path) ? 'i-lucide-check' : 'i-lucide-plus'"
                  :data-testid="`env-setup-file-${c.name}`"
                  @click="store.toggleComposeFile(c.path)"
                >
                  {{ c.name }}<span v-if="c.os" class="ms-1 text-[9px] opacity-70">{{ c.os }}</span>
                </UButton>
              </div>
            </div>

            <!-- compose profiles -->
            <div v-if="profileCandidates.length" class="space-y-1.5">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {{ t('environmentWizard.review.profiles') }}
              </p>
              <div class="flex flex-wrap gap-1.5">
                <UButton
                  v-for="c in profileCandidates"
                  :key="c.profile"
                  size="xs"
                  :color="profileEnabled(c.profile) ? 'primary' : 'neutral'"
                  :variant="profileEnabled(c.profile) ? 'soft' : 'ghost'"
                  :icon="profileEnabled(c.profile) ? 'i-lucide-check' : 'i-lucide-plus'"
                  :data-testid="`env-setup-profile-${c.profile}`"
                  @click="store.toggleProfile(c.profile)"
                >
                  {{ c.profile }}
                </UButton>
              </div>
            </div>

            <!-- seed dumps -->
            <div v-if="seedDumpCandidates.length" class="space-y-1.5">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {{ t('environmentWizard.review.seedDumps') }}
              </p>
              <div class="space-y-1">
                <div
                  v-for="c in seedDumpCandidates"
                  :key="c.path"
                  class="flex items-center justify-between gap-2 rounded border border-slate-800 bg-slate-900/40 px-2 py-1"
                >
                  <span class="truncate text-[11px] text-slate-300">{{ c.path }}</span>
                  <UButton
                    size="xs"
                    :color="seedAdded(c.path) ? 'success' : 'neutral'"
                    :variant="seedAdded(c.path) ? 'soft' : 'ghost'"
                    :icon="seedAdded(c.path) ? 'i-lucide-check' : 'i-lucide-plus'"
                    :disabled="seedAdded(c.path)"
                    :data-testid="`env-setup-seed-${c.name}`"
                    @click="store.addSeedStep(c)"
                  >
                    {{
                      seedAdded(c.path)
                        ? t('environmentWizard.review.seedAdded')
                        : t('environmentWizard.review.seedAdd')
                    }}
                  </UButton>
                </div>
              </div>
            </div>

            <!-- raw recipe editor -->
            <div>
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                :icon="rawOpen ? 'i-lucide-chevron-down' : 'i-lucide-code'"
                data-testid="env-setup-raw-toggle"
                @click="toggleRaw"
              >
                {{ t('environmentWizard.review.rawEditor') }}
              </UButton>
              <div v-if="rawOpen" class="mt-2 space-y-2">
                <UTextarea
                  v-model="rawText"
                  :rows="10"
                  class="w-full font-mono text-[11px]"
                  data-testid="env-setup-raw-text"
                />
                <p
                  v-if="rawError"
                  class="text-[11px] text-rose-300/80"
                  data-testid="env-setup-raw-error"
                >
                  {{ rawError }}
                </p>
                <div class="flex justify-end">
                  <UButton
                    size="xs"
                    color="primary"
                    data-testid="env-setup-raw-apply"
                    @click="applyRaw"
                  >
                    {{ t('environmentWizard.review.rawApply') }}
                  </UButton>
                </div>
              </div>
            </div>
          </template>
        </section>

        <!-- ========================== PREFLIGHT ========================= -->
        <section
          v-else-if="store.step === 'preflight'"
          class="space-y-3"
          data-testid="env-setup-step-preflight"
        >
          <div class="flex items-center justify-between gap-2">
            <p class="text-sm text-slate-400">{{ t('environmentWizard.preflight.intro') }}</p>
            <UButton
              size="xs"
              variant="soft"
              color="primary"
              icon="i-lucide-list-checks"
              :loading="store.preflightRunning"
              data-testid="env-setup-preflight-run"
              @click="store.runPreflight()"
            >
              {{ t('environmentWizard.preflight.run') }}
            </UButton>
          </div>

          <p
            v-if="!store.recipe.prerequisites?.length"
            class="text-[12px] text-slate-500"
            data-testid="env-setup-preflight-none"
          >
            {{ t('environmentWizard.preflight.none') }}
          </p>
          <p
            v-else-if="preflightsUnavailable"
            class="text-[12px] text-amber-300/80"
            data-testid="env-setup-preflight-unavailable"
          >
            {{ t('environmentWizard.preflight.unavailable') }}
          </p>
          <p
            v-if="store.preflightError"
            class="text-[12px] text-rose-300/80"
            data-testid="env-setup-preflight-error"
          >
            {{ store.preflightError }}
          </p>

          <ul
            v-if="store.preflightResults?.length"
            class="space-y-2"
            data-testid="env-setup-preflight-results"
          >
            <li
              v-for="r in store.preflightResults"
              :key="r.title"
              class="rounded border border-slate-800 bg-slate-900/40 p-2"
            >
              <div class="flex items-center gap-2">
                <UBadge :color="PREFLIGHT_COLOR[r.status]" variant="subtle" size="sm">
                  {{ r.status }}
                </UBadge>
                <span class="text-[12px] text-slate-200">{{ r.title }}</span>
                <span v-if="!r.required" class="ms-auto text-[10px] text-slate-500">
                  {{ t('environmentWizard.preflight.optional') }}
                </span>
              </div>
              <p v-if="r.detail" class="mt-1 text-[11px] text-slate-400">{{ r.detail }}</p>
              <pre
                v-if="r.status !== 'pass' && r.remediation"
                class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-amber-900/40 bg-amber-950/20 p-1.5 text-[11px] text-amber-200/90"
                >{{ r.remediation }}</pre
              >
            </li>
          </ul>
        </section>

        <!-- ============================ SAVE ============================ -->
        <section v-else class="space-y-3" data-testid="env-setup-step-save">
          <UFormField
            :label="t('environmentWizard.save.handlerLabel')"
            :description="t('environmentWizard.save.handlerHint')"
          >
            <UInput
              v-model="store.handlerLabel"
              class="w-full"
              data-testid="env-setup-handler-label"
            />
          </UFormField>

          <div
            class="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-[12px] text-slate-300"
          >
            <p>
              {{
                t('environmentWizard.save.summary', {
                  frame: store.targetFrame?.title ?? '',
                  service: store.composeService,
                })
              }}
            </p>
          </div>

          <p
            v-if="store.saveError"
            class="text-[12px] text-rose-300/80"
            data-testid="env-setup-save-error"
          >
            {{ store.saveError }}
          </p>

          <div v-if="!store.saved" class="flex justify-end">
            <UButton
              color="primary"
              icon="i-lucide-save"
              :loading="store.saving"
              :disabled="!store.composeService.trim()"
              data-testid="env-setup-save"
              @click="store.save()"
            >
              {{ t('environmentWizard.save.save') }}
            </UButton>
          </div>

          <!-- saved: confirmation + optional trial provision -->
          <template v-else>
            <div
              class="flex items-center gap-2 rounded-md border border-emerald-800/50 bg-emerald-950/30 p-2 text-[12px] text-emerald-200"
              data-testid="env-setup-saved"
            >
              <UIcon name="i-lucide-check-circle" class="h-4 w-4" />
              {{ t('environmentWizard.save.saved') }}
            </div>

            <div class="flex items-center justify-between gap-2">
              <p class="text-[11px] text-slate-500">{{ t('environmentWizard.trial.hint') }}</p>
              <UButton
                size="xs"
                variant="soft"
                color="neutral"
                icon="i-lucide-play"
                :loading="store.trialing"
                :disabled="store.trialStarted"
                data-testid="env-setup-trial"
                @click="store.trialProvision()"
              >
                {{ t('environmentWizard.trial.run') }}
              </UButton>
            </div>
            <p v-if="store.trialError" class="text-[11px] text-rose-300/80">
              {{ store.trialError }}
            </p>
            <ProvisioningLogsDrawer v-if="store.trialStarted" subsystem="environment" />
          </template>
        </section>

        <!-- footer nav -->
        <div class="flex items-center justify-between border-t border-slate-800 pt-3">
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="currentIndex === 0"
            icon="i-lucide-arrow-left"
            data-testid="env-setup-back"
            @click="back"
          >
            {{ t('common.back') }}
          </UButton>
          <UButton
            v-if="store.step !== 'save'"
            color="primary"
            trailing-icon="i-lucide-arrow-right"
            :disabled="(store.step === 'review' && !canLeaveReview) || store.step === 'pick'"
            data-testid="env-setup-next"
            @click="next"
          >
            {{ t('common.next') }}
          </UButton>
          <UButton
            v-else
            color="neutral"
            variant="soft"
            icon="i-lucide-check"
            data-testid="env-setup-done"
            @click="ui.closeEnvironmentSetup()"
          >
            {{ t('common.done') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
