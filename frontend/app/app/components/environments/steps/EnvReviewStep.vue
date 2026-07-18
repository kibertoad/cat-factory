<script setup lang="ts">
// The environment-setup journey's REVIEW step (slice 3 of the modular-vue adoption).
// Seeds the data layer for the journey's target frame (idempotent per frame, so
// back-navigation doesn't clobber edits), then presents the detected + optionally
// analyst-augmented `docker-compose` recipe for the operator to confirm/edit.
// Firing the journey's `advance` exit (gated until a recommendation + exposed
// service exist) advances to the preflight step.
import { computed, ref, watch } from 'vue'
import type {
  MergeableRecipeField,
  ProvisioningComposeFileCandidate,
  ProvisioningProfileCandidate,
  ProvisioningSeedDumpCandidate,
} from '@cat-factory/contracts'
import JourneyStepNav from '~/components/environments/steps/JourneyStepNav.vue'

const props = defineProps<{
  input: { frameId: string | null }
  exit: (name: 'advance') => void
  goBack?: () => void
}>()

const store = useEnvironmentWizardStore()
const { t } = useI18n()

// Bridge the journey's target frame into the data store. Idempotent per frame
// (see `beginForFrame`), so re-entry / back-nav / resume keeps in-progress edits.
watch(
  () => props.input.frameId,
  (id) => store.beginForFrame(id),
  { immediate: true },
)

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

// ---- Step gating ------------------------------------------------------------
const canLeaveReview = computed(
  () => !!store.recommendation && store.composeService.trim().length > 0,
)
</script>

<template>
  <section class="space-y-4" data-testid="env-setup-step-review">
    <!-- detection status -->
    <div class="flex items-center justify-between gap-2">
      <div class="min-w-0">
        <p class="text-sm font-medium text-slate-200">{{ store.targetFrame?.title }}</p>
        <p class="text-[11px] text-slate-500">{{ t('environmentWizard.review.detectHint') }}</p>
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
          <span>{{ t('environmentWizard.analysis.cliNudge', { path: repoCliHint.path }) }}</span>
        </p>
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <p class="text-[12px] font-medium text-slate-300">
              {{ t('environmentWizard.analysis.title') }}
            </p>
            <p class="text-[11px] text-slate-500">{{ t('environmentWizard.analysis.hint') }}</p>
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
        <p v-else-if="store.analysisStatus === 'failed'" class="mt-2 text-[11px] text-rose-300/80">
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
          <p v-if="rawError" class="text-[11px] text-rose-300/80" data-testid="env-setup-raw-error">
            {{ rawError }}
          </p>
          <div class="flex justify-end">
            <UButton size="xs" color="primary" data-testid="env-setup-raw-apply" @click="applyRaw">
              {{ t('environmentWizard.review.rawApply') }}
            </UButton>
          </div>
        </div>
      </div>
    </template>

    <JourneyStepNav :go-back="goBack">
      <template #primary>
        <UButton
          color="primary"
          trailing-icon="i-lucide-arrow-right"
          :disabled="!canLeaveReview"
          data-testid="env-setup-next"
          @click="exit('advance')"
        >
          {{ t('common.next') }}
        </UButton>
      </template>
    </JourneyStepNav>
  </section>
</template>
