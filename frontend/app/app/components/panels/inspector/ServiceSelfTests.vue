<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Block, EnvironmentTestMode, EnvironmentTestStage } from '~/types/domain'
import type { ConflictReason } from '@cat-factory/contracts'
import { environmentProbeSurfaceFor } from '@cat-factory/contracts'
import EnvProbeReport from '~/components/panels/inspector/EnvProbeReport.vue'
import { apiErrorEnvelope } from '~/composables/api/errors'
import { parseConflict } from '~/composables/usePipelineErrorToast'

// The two SELF-TESTS a service frame offers, side by side, because they answer consecutive
// questions about the same environment:
//
//   1. "Test environment creation": does the provisioning config stand an environment up and
//      take it down again? (create branch → provision → tear down → delete branch)
//   2. "Test agent dry run": handed that environment, could an AGENT actually operate the
//      service: work out what to call, authenticate, and get something real done? It adds one
//      `probing` stage in the middle and comes back with a report.
//
// One component rather than two because they share every piece of state and every refusal: the
// same store, the same `infraless` precondition, the same 409 vocabulary, the same
// jump-to-the-handler remedy. Extracted out of `ServiceTestConfig.vue`, which owns the service's
// provisioning CONFIG and was the wrong home for a pair of run controls.
const props = defineProps<{ block: Block }>()

const envTest = useEnvironmentTestStore()
const ui = useUiStore()
const { t, te } = useI18n()

/** Nothing to provision for an `infraless` service, so neither self-test has a subject. */
const canTest = computed(() => (props.block.provisioning?.type ?? 'infraless') !== 'infraless')

/**
 * Which prober the dry run would use, through the SAME rule the backend picks it with. Rendered
 * in the hint so a developer knows what they are about to spend a container on: a browser run on
 * a frontend frame, HTTP calls on everything else.
 */
const probeSurface = computed(() => environmentProbeSurfaceFor(props.block.type))

/**
 * The self-test's start/stop error, per mode. Structured (not a bare string) so the
 * not-provisionable case can render its remedy prose PLUS a one-click jump to the
 * environment-handler config; every other case is plain text.
 */
interface SelfTestError {
  text: string
  /** Show the "Configure infrastructure" deep-link: only the not-provisionable handler case. */
  configurable?: boolean
}
const errors = ref<Partial<Record<EnvironmentTestMode, SelfTestError>>>({})
const starting = ref<Partial<Record<EnvironmentTestMode, boolean>>>({})

/**
 * The newest run for this frame in one mode: re-attaches after a reconnect (running runs are
 * carried in the snapshot), so the live stage keeps showing without a locally-held id. Scoped by
 * mode so each control reports its OWN run rather than whichever ran last.
 */
const provisionRun = computed(() => envTest.runForBlock(props.block.id, 'provision'))
const probeRun = computed(() => envTest.runForBlock(props.block.id, 'agent-probe'))
function runFor(mode: EnvironmentTestMode) {
  return mode === 'agent-probe' ? probeRun.value : provisionRun.value
}
function isRunning(mode: EnvironmentTestMode) {
  return runFor(mode)?.status === 'running'
}

// Per-stage label KEYS, exhaustive over the contracts `EnvironmentTestStage` union: a new
// backend stage fails THIS typecheck until mapped (the key is resolved at runtime, so the
// typed-message-keys check can't see the `t()` lookup: the map's exhaustiveness is the
// drift guard, same pattern as `CONFLICT_TITLE_KEYS`).
const STAGE_KEYS: Record<EnvironmentTestStage, string> = {
  creating_branch: 'inspector.testConfig.envTest.stage.creating_branch',
  provisioning: 'inspector.testConfig.envTest.stage.provisioning',
  probing: 'inspector.testConfig.envTest.stage.probing',
  tearing_down: 'inspector.testConfig.envTest.stage.tearing_down',
  deleting_branch: 'inspector.testConfig.envTest.stage.deleting_branch',
  done: 'inspector.testConfig.envTest.stage.done',
}

function stageLabel(stage: EnvironmentTestStage): string {
  const key = STAGE_KEYS[stage]
  // `te`-guarded so a locale missing the key shows the raw stage id, never a raw message key.
  return te(key) ? t(key) : stage
}

// The start preflight's machine-readable 409 reasons, mapped to their localized titles,
// exhaustive over the contracts `env_test_*` conflict reasons (same drift guard as above).
// The raw backend `message` is only the last-resort fallback for unmapped/non-conflict errors.
const CONFLICT_KEYS: Record<Extract<ConflictReason, `env_test_${string}`>, string> = {
  env_test_not_a_frame: 'errors.conflict.title.env_test_not_a_frame',
  env_test_infraless: 'errors.conflict.title.env_test_infraless',
  env_test_not_provisionable: 'errors.conflict.title.env_test_not_provisionable',
  env_test_no_vcs: 'errors.conflict.title.env_test_no_vcs',
  env_test_connection_failed: 'errors.conflict.title.env_test_connection_failed',
  env_test_probe_unavailable: 'errors.conflict.title.env_test_probe_unavailable',
}

function buildError(e: unknown): SelfTestError {
  const parsed = parseConflict(e)
  const reason = parsed?.reason
  // No workspace handler resolves for the service's provision type. Word the SPECIFIC case,
  // nothing configured vs. an ambiguous match (carried on `details.handlerIssue`, distinct from the
  // `env_test_not_provisionable` code), and offer the one-click jump to the Infrastructure →
  // Test-environments handler config.
  if (reason === 'env_test_not_provisionable') {
    const ambiguous = parsed?.details.handlerIssue === 'type-mismatch'
    return {
      text: t(
        ambiguous
          ? 'errors.conflict.description.env_test_not_provisionable_type_mismatch'
          : 'errors.conflict.description.env_test_not_provisionable_no_handler',
      ),
      configurable: true,
    }
  }
  // The handler resolved but its live connection probe failed. The provider's OWN message is the
  // actionable part ("project 'X' was not found"), so wrap it in localized prose rather than
  // replacing it with a generic sentence, and offer the same jump, since the fix is in the
  // handler's connection config.
  if (reason === 'env_test_connection_failed' && parsed?.message) {
    return {
      text: t('errors.conflict.description.env_test_connection_failed_detail', {
        detail: parsed.message,
      }),
      configurable: true,
    }
  }
  const key =
    reason && reason in CONFLICT_KEYS
      ? CONFLICT_KEYS[reason as keyof typeof CONFLICT_KEYS]
      : undefined
  if (key && te(key)) return { text: t(key) }
  return { text: apiErrorEnvelope(e)?.message ?? (e instanceof Error ? e.message : String(e)) }
}

async function start(mode: EnvironmentTestMode) {
  if (!canTest.value || starting.value[mode] || isRunning(mode)) return
  starting.value = { ...starting.value, [mode]: true }
  errors.value = { ...errors.value, [mode]: undefined }
  try {
    await envTest.start(props.block.id, mode)
  } catch (e) {
    errors.value = { ...errors.value, [mode]: buildError(e) }
  } finally {
    starting.value = { ...starting.value, [mode]: false }
  }
}

async function stop(mode: EnvironmentTestMode) {
  const run = runFor(mode)
  if (!run || run.status !== 'running') return
  try {
    await envTest.stop(run.id)
  } catch (e) {
    errors.value = { ...errors.value, [mode]: buildError(e) }
  }
}
</script>

<template>
  <div class="mt-3 space-y-3 border-t border-white/5 pt-3" data-testid="env-test-section">
    <!-- 1. The provisioning self-test: the whole lifecycle against a throwaway branch. -->
    <div class="flex items-center justify-between gap-2">
      <div class="min-w-0">
        <p class="text-[11px] font-medium text-slate-300">
          {{ t('inspector.testConfig.envTest.title') }}
        </p>
        <p class="text-[11px] text-slate-400">{{ t('inspector.testConfig.envTest.hint') }}</p>
      </div>
      <UButton
        v-if="!isRunning('provision')"
        icon="i-lucide-flask-conical"
        size="xs"
        color="primary"
        variant="soft"
        data-testid="env-test-start"
        :loading="starting.provision"
        :disabled="!canTest"
        @click="start('provision')"
      >
        {{ t('inspector.testConfig.envTest.start') }}
      </UButton>
      <UButton
        v-else
        icon="i-lucide-square"
        size="xs"
        color="neutral"
        variant="ghost"
        data-testid="env-test-stop"
        @click="stop('provision')"
      >
        {{ t('inspector.testConfig.envTest.stop') }}
      </UButton>
    </div>

    <p
      v-if="provisionRun"
      class="text-[11px]"
      :class="{
        'text-sky-300/80': provisionRun.status === 'running',
        'text-emerald-300/80': provisionRun.status === 'succeeded',
        'text-rose-300/80': provisionRun.status === 'failed',
      }"
      data-testid="env-test-status"
    >
      <template v-if="provisionRun.status === 'running'">
        {{ t('inspector.testConfig.envTest.running', { stage: stageLabel(provisionRun.stage) }) }}
      </template>
      <template v-else-if="provisionRun.status === 'succeeded'">
        {{ t('inspector.testConfig.envTest.succeeded') }}
      </template>
      <template v-else>
        {{ t('inspector.testConfig.envTest.failed') }}
        <template v-if="provisionRun.failedStage">
          ({{ stageLabel(provisionRun.failedStage) }})
        </template>
        <span v-if="provisionRun.error" class="block text-rose-300/70">
          {{ provisionRun.error }}
        </span>
      </template>
    </p>

    <div v-if="errors.provision" class="text-[11px] text-rose-400" data-testid="env-test-error">
      <p>{{ errors.provision.text }}</p>
      <!-- Only the not-provisionable handler case is one-click fixable: jump to Infrastructure →
           Test environments, where the workspace's per-type environment handler is registered. -->
      <UButton
        v-if="errors.provision.configurable"
        class="mt-1.5"
        icon="i-lucide-settings"
        size="xs"
        color="neutral"
        variant="soft"
        data-testid="env-test-configure-handler"
        @click="ui.openProviderConnection('environment')"
      >
        {{ t('errors.conflict.action.configureInfrastructure') }}
      </UButton>
    </div>

    <!-- 2. The agent dry run: the same lifecycle plus a prober, reporting what an agent could
         and could not do with the environment it was handed. -->
    <div class="flex items-center justify-between gap-2 border-t border-white/5 pt-3">
      <div class="min-w-0">
        <p class="text-[11px] font-medium text-slate-300">
          {{ t('inspector.testConfig.envProbe.title') }}
        </p>
        <p class="text-[11px] text-slate-400">
          {{ t('inspector.testConfig.envProbe.hint') }}
          {{
            probeSurface === 'ui'
              ? t('inspector.testConfig.envProbe.surfaceUi')
              : t('inspector.testConfig.envProbe.surfaceApi')
          }}
        </p>
      </div>
      <UButton
        v-if="!isRunning('agent-probe')"
        icon="i-lucide-bot"
        size="xs"
        color="primary"
        variant="soft"
        data-testid="env-probe-start"
        :loading="starting['agent-probe']"
        :disabled="!canTest"
        @click="start('agent-probe')"
      >
        {{ t('inspector.testConfig.envProbe.start') }}
      </UButton>
      <UButton
        v-else
        icon="i-lucide-square"
        size="xs"
        color="neutral"
        variant="ghost"
        data-testid="env-probe-stop"
        @click="stop('agent-probe')"
      >
        {{ t('inspector.testConfig.envTest.stop') }}
      </UButton>
    </div>

    <p v-if="!canTest" class="text-[11px] text-slate-500">
      {{ t('inspector.testConfig.envTest.infraless') }}
    </p>

    <p
      v-if="probeRun"
      class="text-[11px]"
      :class="{
        'text-sky-300/80': probeRun.status === 'running',
        'text-emerald-300/80': probeRun.status === 'succeeded',
        'text-rose-300/80': probeRun.status === 'failed',
      }"
      data-testid="env-probe-status"
    >
      <template v-if="probeRun.status === 'running'">
        {{ t('inspector.testConfig.envTest.running', { stage: stageLabel(probeRun.stage) }) }}
      </template>
      <template v-else-if="probeRun.status === 'succeeded'">
        {{ t('inspector.testConfig.envProbe.completed') }}
      </template>
      <template v-else>
        {{ t('inspector.testConfig.envProbe.failed') }}
        <template v-if="probeRun.failedStage">({{ stageLabel(probeRun.failedStage) }})</template>
        <span v-if="probeRun.error" class="block text-rose-300/70">{{ probeRun.error }}</span>
      </template>
    </p>

    <!-- The report renders whatever the dry run got as far as, on a succeeded run AND on one that
         failed after the probe reported: the finding is the product, and withholding it because a
         later stage broke would hide the only thing the run was for. -->
    <EnvProbeReport v-if="probeRun?.probe" :report="probeRun.probe" />

    <div
      v-if="errors['agent-probe']"
      class="text-[11px] text-rose-400"
      data-testid="env-probe-error"
    >
      <p>{{ errors['agent-probe']!.text }}</p>
      <UButton
        v-if="errors['agent-probe']!.configurable"
        class="mt-1.5"
        icon="i-lucide-settings"
        size="xs"
        color="neutral"
        variant="soft"
        data-testid="env-probe-configure-handler"
        @click="ui.openProviderConnection('environment')"
      >
        {{ t('errors.conflict.action.configureInfrastructure') }}
      </UButton>
    </div>
  </div>
</template>
