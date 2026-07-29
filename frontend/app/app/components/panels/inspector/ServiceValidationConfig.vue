<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'
import {
  VALIDATION_DEFAULT_MAX_ATTEMPTS,
  VALIDATION_MAX_ATTEMPTS_CEILING,
  VALIDATION_MAX_CHECKS,
  type ValidationCheck,
  type ValidationEcosystem,
} from '~/types/validationChecks'
import { mergeDetectedChecks } from '~/utils/validationDetection'

// Per-service (frame) PRE-PR VALIDATION CHECKS: the shell commands the executor-harness runs
// against the checkout after the coder settles and BEFORE the PR opens. A failing command's
// output is handed back to the agent, which retries under the attempt budget; only a green
// checkout opens a PR, and an exhausted budget fails the step with the captured output.
// Keyed by THIS block's id (service frames only — a task resolves its checks up the frame chain).
const props = defineProps<{ block: Block }>()

const store = useValidationChecksStore()
const toast = useToast()
const { t, te } = useI18n()
const { confirmAction, toastDone } = useConfirmAction()

const busy = ref(false)
const detecting = ref(false)
const rows = ref<ValidationCheck[]>([])
const maxAttempts = ref(VALIDATION_DEFAULT_MAX_ATTEMPTS)

const saved = computed(() => store.forBlock(props.block.id))
const configured = computed(() => saved.value.checks.length > 0)
const canAdd = computed(() => rows.value.length < VALIDATION_MAX_CHECKS)
/** A row is only submittable once it has a command; the label falls back to the command. */
const submittable = computed(() =>
  rows.value
    .map((r) => ({ label: r.label.trim() || r.command.trim(), command: r.command.trim() }))
    .filter((r) => r.command.length > 0),
)

onMounted(() => {
  store.ensureLoaded().catch(() => {})
})
watch(
  saved,
  (config) => {
    rows.value = config.checks.map((c) => ({ ...c }))
    maxAttempts.value = config.maxAttempts
  },
  { immediate: true },
)

function addRow() {
  if (canAdd.value) rows.value.push({ label: '', command: '' })
}

function removeRow(index: number) {
  rows.value.splice(index, 1)
}

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

// Ecosystem label KEYS, exhaustive over the contracts `ValidationEcosystem` union: a new
// backend detector fails THIS typecheck until it is mapped (the key is assembled at runtime,
// so the typed-message-keys check cannot see the `t()` lookup — the map's exhaustiveness is
// the drift guard, same pattern as `ENV_TEST_STAGE_KEYS`).
const ECOSYSTEM_KEYS: Record<ValidationEcosystem, string> = {
  node: 'inspector.validationChecks.ecosystem.node',
  python: 'inspector.validationChecks.ecosystem.python',
  go: 'inspector.validationChecks.ecosystem.go',
  rust: 'inspector.validationChecks.ecosystem.rust',
  maven: 'inspector.validationChecks.ecosystem.maven',
  gradle: 'inspector.validationChecks.ecosystem.gradle',
  dotnet: 'inspector.validationChecks.ecosystem.dotnet',
  ruby: 'inspector.validationChecks.ecosystem.ruby',
  php: 'inspector.validationChecks.ecosystem.php',
  elixir: 'inspector.validationChecks.ecosystem.elixir',
  make: 'inspector.validationChecks.ecosystem.make',
  just: 'inspector.validationChecks.ecosystem.just',
  task: 'inspector.validationChecks.ecosystem.task',
}

function ecosystemLabel(id: ValidationEcosystem): string {
  const key = ECOSYSTEM_KEYS[id]
  // `te`-guarded so a locale missing the key shows the raw id, never a raw message key.
  return te(key) ? t(key) : id
}

/**
 * Fill the rows from what the service's repo declares. The suggestion is NOT saved — it
 * lands in the same unsaved rows the operator edits by hand, so Detect is always reversible
 * by walking away from the panel.
 */
async function detect() {
  detecting.value = true
  try {
    const result = await store.detect(props.block.id)
    if (result.status !== 'ok') {
      // The backend distinguishes "no repo linked" from "the repo could not be read"; say
      // which, because they send the operator to different places.
      toast.add({
        title: t(`inspector.validationChecks.detect.${result.status}`),
        icon: 'i-lucide-triangle-alert',
        color: 'warning',
      })
      return
    }
    const merged = mergeDetectedChecks(rows.value, result.checks, VALIDATION_MAX_CHECKS)
    rows.value = merged.rows
    if (merged.added === 0) {
      toast.add({
        title: t('inspector.validationChecks.detect.nothingNew'),
        description:
          result.checks.length > 0
            ? t('inspector.validationChecks.detect.alreadyPresent')
            : t('inspector.validationChecks.detect.unrecognised'),
        icon: 'i-lucide-info',
        color: 'neutral',
      })
      return
    }
    const names = result.ecosystems.map(ecosystemLabel).join(', ')
    toast.add({
      title: t('inspector.validationChecks.detect.added', { count: merged.added }, merged.added),
      // Name what was recognised AND what was left out: a cap that silently swallowed a
      // suggestion reads as "that is everything your repo has".
      description: [
        names ? t('inspector.validationChecks.detect.found', { ecosystems: names }) : '',
        merged.dropped > 0 || result.truncated
          ? t('inspector.validationChecks.detect.capped', { max: VALIDATION_MAX_CHECKS })
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      icon: 'i-lucide-wand-sparkles',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('inspector.validationChecks.detect.failed'), e)
  } finally {
    detecting.value = false
  }
}

async function save() {
  busy.value = true
  try {
    await store.save(props.block.id, submittable.value, maxAttempts.value)
    toast.add({
      title: t('inspector.validationChecks.savedToast'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('inspector.validationChecks.saveFailed'), e)
  } finally {
    busy.value = false
  }
}

async function clear() {
  const noun = t('inspector.validationChecks.configNoun')
  if (!(await confirmAction('clear', noun))) return
  busy.value = true
  try {
    await store.remove(props.block.id)
    rows.value = []
    toastDone('clear', noun)
  } catch (e) {
    notifyError(t('inspector.validationChecks.clearFailed'), e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <InspectorSection
    v-if="store.available !== false"
    :title="t('inspector.validationChecks.title')"
    :hint="t('inspector.validationChecks.sectionHint')"
    data-testid="service-validation-config"
  >
    <template #actions>
      <UButton
        v-if="configured"
        color="error"
        variant="ghost"
        size="xs"
        icon="i-lucide-trash-2"
        :loading="busy"
        data-testid="validation-clear"
        @click="clear"
      >
        {{ t('inspector.validationChecks.clear') }}
      </UButton>
    </template>

    <div class="space-y-2">
      <p class="text-[11px] text-slate-500">
        {{ t('inspector.validationChecks.hint') }}
      </p>

      <div
        v-for="(row, index) in rows"
        :key="index"
        class="flex items-end gap-2"
        data-testid="validation-check-row"
      >
        <UFormField :label="t('inspector.validationChecks.label')" class="w-1/3">
          <UInput
            v-model="row.label"
            :placeholder="t('inspector.validationChecks.labelPlaceholder')"
            size="sm"
            class="w-full"
            data-testid="validation-check-label"
          />
        </UFormField>
        <UFormField :label="t('inspector.validationChecks.command')" class="flex-1">
          <UInput
            v-model="row.command"
            placeholder="pnpm lint"
            size="sm"
            class="w-full"
            data-testid="validation-check-command"
          />
        </UFormField>
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-x"
          :aria-label="t('inspector.validationChecks.removeCheck')"
          data-testid="validation-check-remove"
          @click="removeRow(index)"
        />
      </div>

      <p v-if="rows.length === 0" class="text-[11px] text-slate-500" data-testid="validation-empty">
        {{ t('inspector.validationChecks.empty') }}
      </p>

      <div class="flex items-end justify-between gap-2">
        <UFormField
          :label="t('inspector.validationChecks.maxAttempts')"
          :hint="t('inspector.validationChecks.maxAttemptsHint')"
          class="w-40"
        >
          <UInput
            v-model.number="maxAttempts"
            type="number"
            :min="1"
            :max="VALIDATION_MAX_ATTEMPTS_CEILING"
            size="sm"
            class="w-full"
            data-testid="validation-max-attempts"
          />
        </UFormField>
        <div class="flex gap-2">
          <UButton
            color="neutral"
            variant="soft"
            size="xs"
            icon="i-lucide-wand-sparkles"
            :loading="detecting"
            :disabled="!canAdd"
            :title="t('inspector.validationChecks.detect.hint')"
            data-testid="validation-detect"
            @click="detect"
          >
            {{ t('inspector.validationChecks.detect.action') }}
          </UButton>
          <UButton
            color="neutral"
            variant="soft"
            size="xs"
            icon="i-lucide-plus"
            :disabled="!canAdd"
            data-testid="validation-add-check"
            @click="addRow"
          >
            {{ t('inspector.validationChecks.addCheck') }}
          </UButton>
          <UButton
            color="primary"
            variant="soft"
            size="xs"
            icon="i-lucide-save"
            :loading="busy"
            data-testid="validation-save"
            @click="save"
          >
            {{ t('inspector.validationChecks.save') }}
          </UButton>
        </div>
      </div>
    </div>
  </InspectorSection>
</template>
