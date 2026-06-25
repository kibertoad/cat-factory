<script setup lang="ts">
// Slack integration panel. Slack is an extra delivery transport for the existing
// notifications (merge_review / pipeline_complete / ci_failed). Three sections:
//   - Connection (per-account): "Add to Slack" (OAuth) or paste a bot token.
//   - Routing (per-workspace): per-type enable + channel.
//   - Mentions (per-account): toggle + GitHub-user-id → Slack-member-id map.
import { computed, reactive, ref, watch } from 'vue'
import type { NotificationType } from '~/types/notifications'
import type { SlackMemberMappingEntry, SlackMemberRole, SlackRoute } from '~/types/slack'

const ui = useUiStore()
const slack = useSlackStore()
const toast = useToast()

const open = computed({
  get: () => ui.slackOpen,
  set: (v: boolean) => (v ? ui.openSlack() : ui.closeSlack()),
})

const ROUTABLE: { type: NotificationType; label: string }[] = [
  { type: 'merge_review', label: 'Merge review' },
  { type: 'pipeline_complete', label: 'Pipeline complete' },
  { type: 'ci_failed', label: 'CI failed' },
  { type: 'test_failed', label: 'Tests failed' },
  { type: 'requirement_review', label: 'Requirement review' },
  { type: 'clarity_review', label: 'Clarity review' },
  { type: 'release_regression', label: 'Release regression' },
  { type: 'human_test_ready', label: 'Ready for human testing' },
]

/** Notification-role options for a mapped member (drives who gets @-mentioned). */
const ROLE_OPTIONS: SlackMemberRole[] = ['engineering', 'product']

// Local editable copies, synced from the store on load.
const routes = reactive<Record<NotificationType, SlackRoute>>({
  merge_review: { enabled: false, channel: '' },
  pipeline_complete: { enabled: false, channel: '' },
  ci_failed: { enabled: false, channel: '' },
  test_failed: { enabled: false, channel: '' },
  requirement_review: { enabled: false, channel: '' },
  clarity_review: { enabled: false, channel: '' },
  release_regression: { enabled: false, channel: '' },
  // In-app only (not in ROUTABLE), but the map is exhaustive over the type.
  decision_required: { enabled: false, channel: '' },
  human_test_ready: { enabled: false, channel: '' },
})
const mentionsEnabled = ref(false)
const mapping = ref<SlackMemberMappingEntry[]>([])
const tokenInput = ref('')
const busy = ref(false)

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

// Load everything the panel needs whenever it opens and Slack is connected.
watch(
  () => open.value,
  async (isOpen) => {
    if (!isOpen || !slack.connected) return
    try {
      await Promise.all([slack.loadSettings(), slack.loadMemberMapping(), slack.loadChannels()])
      for (const { type } of ROUTABLE) {
        routes[type] = slack.settings?.routes[type] ?? { enabled: false, channel: '' }
      }
      mentionsEnabled.value = slack.settings?.mentionsEnabled ?? false
      mapping.value = slack.memberMapping.map((e) => ({ role: 'engineering', ...e }))
    } catch (e) {
      notifyError('Could not load Slack settings', e)
    }
  },
)

async function connectViaOAuth() {
  try {
    window.location.href = await slack.installUrl()
  } catch (e) {
    notifyError('Could not start Slack OAuth', e)
  }
}

async function connectWithToken() {
  if (!tokenInput.value.trim()) return
  try {
    await slack.connectWithToken(tokenInput.value.trim())
    tokenInput.value = ''
    toast.add({ title: 'Slack connected', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError('Could not connect Slack', e)
  }
}

async function disconnect() {
  try {
    await slack.disconnect()
  } catch (e) {
    notifyError('Could not disconnect Slack', e)
  }
}

async function saveRouting() {
  busy.value = true
  try {
    await slack.updateSettings({
      routes: { ...routes },
      mentionsEnabled: mentionsEnabled.value,
    })
    toast.add({ title: 'Routing saved', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError('Could not save routing', e)
  } finally {
    busy.value = false
  }
}

function addMapping() {
  mapping.value.push({ userId: '', slackUserId: '', role: 'engineering' })
}
function removeMapping(index: number) {
  mapping.value.splice(index, 1)
}
async function saveMapping() {
  busy.value = true
  try {
    const entries = mapping.value.filter((e) => e.userId.trim() && e.slackUserId.trim())
    await slack.updateMemberMapping(entries)
    mapping.value = slack.memberMapping.map((e) => ({ ...e }))
    toast.add({ title: 'Member map saved', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError('Could not save member map', e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Slack notifications" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="space-y-5">
        <p class="text-xs text-slate-400">
          Post board notifications (merge reviews, pipeline completions, CI failures) to Slack. The
          connection is shared across the account; routing is per board.
        </p>

        <!-- not connected: connect UI -->
        <div v-if="!slack.connected" class="space-y-3 rounded-lg border border-slate-700 p-3">
          <UButton
            v-if="slack.oauthEnabled"
            color="primary"
            icon="i-lucide-slack"
            @click="connectViaOAuth"
          >
            Add to Slack
          </UButton>
          <div class="space-y-1">
            <span class="block text-[10px] uppercase tracking-wide text-slate-500">
              …or paste a bot token (xoxb-…)
            </span>
            <div class="flex gap-2">
              <UInput
                v-model="tokenInput"
                size="sm"
                class="flex-1"
                type="password"
                placeholder="xoxb-…"
              />
              <UButton
                color="primary"
                variant="soft"
                size="sm"
                :loading="slack.connecting"
                :disabled="!tokenInput.trim()"
                @click="connectWithToken"
              >
                Connect
              </UButton>
            </div>
          </div>
        </div>

        <!-- connected -->
        <template v-else>
          <div
            class="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/40 p-3"
          >
            <UIcon name="i-lucide-slack" class="text-emerald-400" />
            <span class="flex-1 text-sm text-slate-200">
              Connected to <span class="font-semibold">{{ slack.connection?.teamName }}</span>
            </span>
            <UButton
              color="error"
              variant="ghost"
              size="xs"
              icon="i-lucide-unplug"
              @click="disconnect"
            >
              Disconnect
            </UButton>
          </div>

          <!-- routing -->
          <div class="space-y-3">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Routing</p>
            <div
              v-for="row in ROUTABLE"
              :key="row.type"
              class="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/40 p-2"
            >
              <USwitch v-model="routes[row.type]!.enabled" size="sm" />
              <span class="w-32 text-sm text-slate-300">{{ row.label }}</span>
              <UInput
                v-model="routes[row.type]!.channel"
                size="sm"
                class="flex-1"
                placeholder="#channel or channel id"
                :disabled="!routes[row.type]!.enabled"
                list="slack-channels"
              />
            </div>
            <datalist id="slack-channels">
              <option v-for="ch in slack.channels" :key="ch.id" :value="`#${ch.name}`" />
            </datalist>

            <label class="flex items-center gap-2">
              <USwitch v-model="mentionsEnabled" size="sm" />
              <span class="text-sm text-slate-300">@-mention mapped account members</span>
            </label>

            <div class="flex justify-end">
              <UButton
                color="primary"
                variant="soft"
                size="xs"
                icon="i-lucide-save"
                :loading="busy"
                @click="saveRouting"
              >
                Save routing
              </UButton>
            </div>
          </div>

          <!-- member mapping -->
          <div v-if="mentionsEnabled" class="space-y-2">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Member map (user id → Slack member id)
            </p>
            <p class="text-[11px] leading-snug text-slate-500">
              <span class="font-medium text-slate-400">Product</span> people are mentioned on
              requirement-review findings; everyone else only when they created the task.
            </p>
            <div v-for="(entry, i) in mapping" :key="i" class="flex items-center gap-2">
              <UInput v-model="entry.userId" size="sm" class="w-40" placeholder="User id (usr_…)" />
              <UInput
                v-model="entry.slackUserId"
                size="sm"
                class="flex-1"
                placeholder="Slack member id (U…)"
              />
              <USelect v-model="entry.role" :items="ROLE_OPTIONS" size="sm" class="w-32" />
              <UButton
                color="error"
                variant="ghost"
                size="xs"
                icon="i-lucide-trash-2"
                @click="removeMapping(i)"
              />
            </div>
            <div class="flex justify-between">
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-plus"
                @click="addMapping"
              >
                Add member
              </UButton>
              <UButton
                color="primary"
                variant="soft"
                size="xs"
                icon="i-lucide-save"
                :loading="busy"
                @click="saveMapping"
              >
                Save map
              </UButton>
            </div>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
