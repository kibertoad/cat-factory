<script setup lang="ts">
// Datadog post-release-health settings. Two sections:
//   - Connection (per-workspace): site + API/app keys (write-only, never read back).
//   - Monitor/SLO mappings (per service-frame block): which monitors/SLOs the
//     `post-release-health` gate watches after that service's PRs ship.
import { computed, reactive, ref, watch } from 'vue'

const ui = useUiStore()
const store = useReleaseHealthStore()
const toast = useToast()

const open = computed({
  get: () => ui.datadogOpen,
  set: (v: boolean) => (v ? ui.openDatadog() : ui.closeDatadog()),
})

const conn = reactive({ site: 'datadoghq.com', apiKey: '', appKey: '' })
const busy = ref(false)

// New-mapping form.
const draft = reactive({ blockId: '', monitorIds: '', sloIds: '', envTag: '' })

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

watch(
  () => open.value,
  async (isOpen) => {
    if (!isOpen) return
    try {
      await store.load()
      if (store.connection.site) conn.site = store.connection.site
    } catch (e) {
      notifyError('Could not load Datadog settings', e)
    }
  },
)

function parseIds(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

async function saveConnection() {
  busy.value = true
  try {
    await store.saveConnection({ site: conn.site, apiKey: conn.apiKey, appKey: conn.appKey })
    conn.apiKey = ''
    conn.appKey = ''
    toast.add({ title: 'Datadog connected', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError('Could not save the Datadog connection', e)
  } finally {
    busy.value = false
  }
}

async function disconnect() {
  busy.value = true
  try {
    await store.removeConnection()
  } catch (e) {
    notifyError('Could not disconnect Datadog', e)
  } finally {
    busy.value = false
  }
}

async function addMapping() {
  if (!draft.blockId.trim()) return
  busy.value = true
  try {
    await store.saveConfig(draft.blockId.trim(), {
      monitorIds: parseIds(draft.monitorIds),
      sloIds: parseIds(draft.sloIds),
      envTag: draft.envTag.trim() || null,
    })
    draft.blockId = ''
    draft.monitorIds = ''
    draft.sloIds = ''
    draft.envTag = ''
  } catch (e) {
    notifyError('Could not save the mapping', e)
  } finally {
    busy.value = false
  }
}

async function removeMapping(blockId: string) {
  busy.value = true
  try {
    await store.removeConfig(blockId)
  } catch (e) {
    notifyError('Could not remove the mapping', e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Datadog post-release health" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="space-y-6">
        <p class="text-sm text-slate-400">
          After a release ships, the <code>post-release-health</code> gate watches the configured
          Datadog monitors/SLOs. On a regression it spawns an on-call agent to investigate (a human
          decides whether to revert).
        </p>

        <!-- Connection -->
        <section class="space-y-3 rounded-lg border border-slate-700 p-3">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold">Connection</h3>
            <UBadge :color="store.connection.connected ? 'success' : 'neutral'" variant="soft">
              {{
                store.connection.connected
                  ? `Connected (${store.connection.site})`
                  : 'Not connected'
              }}
            </UBadge>
          </div>
          <UFormField label="Datadog site">
            <UInput v-model="conn.site" placeholder="datadoghq.com" />
          </UFormField>
          <UFormField label="API key">
            <UInput v-model="conn.apiKey" type="password" placeholder="DD-API-KEY" />
          </UFormField>
          <UFormField label="Application key">
            <UInput v-model="conn.appKey" type="password" placeholder="DD-APPLICATION-KEY" />
          </UFormField>
          <div class="flex gap-2">
            <UButton
              :loading="busy"
              :disabled="!conn.apiKey || !conn.appKey"
              @click="saveConnection"
            >
              Save connection
            </UButton>
            <UButton
              v-if="store.connection.connected"
              color="error"
              variant="soft"
              :loading="busy"
              @click="disconnect"
            >
              Disconnect
            </UButton>
          </div>
        </section>

        <!-- Monitor/SLO mappings -->
        <section class="space-y-3 rounded-lg border border-slate-700 p-3">
          <h3 class="text-sm font-semibold">Monitor / SLO mappings</h3>
          <p class="text-xs text-slate-400">
            Map a service frame's block id to the Datadog monitor and SLO ids that gate its
            releases. Comma-separate multiple ids.
          </p>
          <div
            v-for="c in store.configs"
            :key="c.blockId"
            class="flex items-start justify-between gap-2 rounded border border-slate-800 p-2 text-xs"
          >
            <div class="space-y-0.5">
              <div class="font-mono text-slate-300">{{ c.blockId }}</div>
              <div class="text-slate-400">
                monitors: {{ c.monitorIds.join(', ') || '—' }} · slos:
                {{ c.sloIds.join(', ') || '—' }}
                <span v-if="c.envTag"> · env: {{ c.envTag }}</span>
              </div>
            </div>
            <UButton
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="xs"
              :loading="busy"
              @click="removeMapping(c.blockId)"
            />
          </div>

          <div class="space-y-2 rounded border border-dashed border-slate-700 p-2">
            <UFormField label="Service frame block id">
              <UInput v-model="draft.blockId" placeholder="blk_…" />
            </UFormField>
            <div class="grid grid-cols-2 gap-2">
              <UFormField label="Monitor ids">
                <UInput v-model="draft.monitorIds" placeholder="123, 456" />
              </UFormField>
              <UFormField label="SLO ids">
                <UInput v-model="draft.sloIds" placeholder="abc, def" />
              </UFormField>
            </div>
            <UFormField label="Env tag (optional)">
              <UInput v-model="draft.envTag" placeholder="prod" />
            </UFormField>
            <UButton :loading="busy" :disabled="!draft.blockId" @click="addMapping">
              Add mapping
            </UButton>
          </div>
        </section>
      </div>
    </template>
  </UModal>
</template>
