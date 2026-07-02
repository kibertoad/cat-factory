<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { Block } from '~/types/domain'

// Per-service (frame) post-release-health mapping: which observability monitors/SLOs the
// `post-release-health` gate watches after this service's PRs ship. Keyed by THIS block's
// id (no manual entry) — the global window only owns the connection now. The Attach/save
// control is disabled with a hint until an observability integration is connected.
const props = defineProps<{ block: Block }>()

const store = useReleaseHealthStore()
const ui = useUiStore()
const toast = useToast()
const { t } = useI18n()
const { confirmAction, toastDone } = useConfirmAction()

const busy = ref(false)
const draft = reactive({ monitorIds: '', sloIds: '', envTag: '' })

const connected = computed(() => store.connection.connected)
const saved = computed(() => store.configForBlock(props.block.id))

function parseIds(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// Load the connection + configs once, then hydrate the form from this block's saved config.
onMounted(() => {
  store.ensureLoaded().catch(() => {})
})
watch(
  saved,
  (config) => {
    draft.monitorIds = config?.monitorIds.join(', ') ?? ''
    draft.sloIds = config?.sloIds.join(', ') ?? ''
    draft.envTag = config?.envTag ?? ''
  },
  { immediate: true },
)

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

async function save() {
  busy.value = true
  try {
    await store.saveConfig(props.block.id, {
      monitorIds: parseIds(draft.monitorIds),
      sloIds: parseIds(draft.sloIds),
      envTag: draft.envTag.trim() || null,
    })
    toast.add({
      title: t('inspector.releaseHealth.savedToast'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('inspector.releaseHealth.saveFailed'), e)
  } finally {
    busy.value = false
  }
}

async function clear() {
  const noun = t('inspector.releaseHealth.configNoun')
  if (!(await confirmAction('clear', noun))) return
  busy.value = true
  try {
    await store.removeConfig(props.block.id)
    draft.monitorIds = ''
    draft.sloIds = ''
    draft.envTag = ''
    toastDone('clear', noun)
  } catch (e) {
    notifyError(t('inspector.releaseHealth.clearFailed'), e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('inspector.releaseHealth.title') }}
      </span>
      <UButton
        v-if="saved"
        color="error"
        variant="ghost"
        size="xs"
        icon="i-lucide-trash-2"
        :loading="busy"
        @click="clear"
      >
        {{ t('inspector.releaseHealth.clear') }}
      </UButton>
    </div>

    <!-- Disabled affordance until an observability integration is connected. -->
    <div
      v-if="!connected"
      class="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-[11px] text-slate-400"
    >
      <span>{{ t('inspector.releaseHealth.connectPrompt') }}</span>
      <UButton
        color="neutral"
        variant="soft"
        size="xs"
        icon="i-lucide-plug"
        :title="t('inspector.releaseHealth.connectFirst')"
        @click="ui.openObservabilityConnection()"
      >
        {{ t('inspector.releaseHealth.connect') }}
      </UButton>
    </div>

    <div v-else class="space-y-2">
      <p class="text-[11px] text-slate-500">
        {{ t('inspector.releaseHealth.hint') }}
      </p>
      <div class="grid grid-cols-2 gap-2">
        <UFormField :label="t('inspector.releaseHealth.monitorIds')">
          <UInput v-model="draft.monitorIds" placeholder="123, 456" size="sm" class="w-full" />
        </UFormField>
        <UFormField :label="t('inspector.releaseHealth.sloIds')">
          <UInput v-model="draft.sloIds" placeholder="abc, def" size="sm" class="w-full" />
        </UFormField>
      </div>
      <UFormField :label="t('inspector.releaseHealth.envTag')">
        <UInput v-model="draft.envTag" placeholder="prod" size="sm" class="w-full" />
      </UFormField>
      <div class="flex justify-end">
        <UButton
          color="primary"
          variant="soft"
          size="xs"
          icon="i-lucide-save"
          :loading="busy"
          @click="save"
        >
          {{ t('inspector.releaseHealth.saveMonitoring') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
