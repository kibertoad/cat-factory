<script setup lang="ts">
// Slack integration panel. Slack is an extra delivery transport for the existing
// notifications (merge_review / pipeline_complete / ci_failed). Three sections:
//   - Connection (per-account): "Add to Slack" (OAuth) or paste a bot token.
//   - Routing (per-workspace): per-type enable + channel.
//   - Mentions (per-account): toggle + GitHub-user-id → Slack-member-id map.
import { computed, reactive, ref, watch } from 'vue'
import type { NotificationType } from '~/types/notifications'
import type { SlackMemberRole, SlackRoute } from '~/types/slack'
import {
  type MemberRow,
  emptyMemberRow,
  hasHalfFilledRow,
  toMemberEntries,
  toMemberRow,
} from '~/utils/slackMemberMapping'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'
import SecretInput from '~/components/common/SecretInput.vue'

const ui = useUiStore()
const slack = useSlackStore()
const toast = useToast()
const { t } = useI18n()
const { confirm } = useConfirm()

const open = computed({
  get: () => ui.slackOpen,
  set: (v: boolean) => (v ? ui.openSlack() : ui.closeSlack()),
})
const back = useIntegrationBack(open)

const ROUTABLE = computed<{ type: NotificationType; label: string }[]>(() => [
  { type: 'merge_review', label: t('slack.routable.merge_review') },
  { type: 'pipeline_complete', label: t('slack.routable.pipeline_complete') },
  { type: 'ci_failed', label: t('slack.routable.ci_failed') },
  { type: 'test_failed', label: t('slack.routable.test_failed') },
  { type: 'requirement_review', label: t('slack.routable.requirement_review') },
  { type: 'clarity_review', label: t('slack.routable.clarity_review') },
  { type: 'release_regression', label: t('slack.routable.release_regression') },
  { type: 'human_test_ready', label: t('slack.routable.human_test_ready') },
  { type: 'visual_confirmation_ready', label: t('slack.routable.visual_confirmation_ready') },
  { type: 'pr_review_ready', label: t('slack.routable.pr_review_ready') },
  { type: 'initiative', label: t('slack.routable.initiative') },
  { type: 'platform_health', label: t('slack.routable.platform_health') },
])

/** Notification-role options for a mapped member (drives who gets @-mentioned). */
const ROLE_OPTIONS = computed<{ label: string; value: SlackMemberRole }[]>(() => [
  { label: t('slack.role.engineering'), value: 'engineering' },
  { label: t('slack.role.product'), value: 'product' },
])

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
  visual_confirmation_ready: { enabled: false, channel: '' },
  human_review: { enabled: false, channel: '' },
  followup_pending: { enabled: false, channel: '' },
  fork_decision_pending: { enabled: false, channel: '' },
  pr_review_ready: { enabled: false, channel: '' },
  initiative: { enabled: false, channel: '' },
  platform_health: { enabled: false, channel: '' },
  budget_paused: { enabled: false, channel: '' },
})
const mentionsEnabled = ref(false)
// Editable member rows carry a client-only stable `uid` (see `slackMemberMapping`) so
// a mid-list delete keys the v-model by identity, not the array index (index keys
// silently rebound a neighbour's inputs — UX-23).
let uidSeq = 0
const nextUid = () => `m${++uidSeq}`
const mapping = ref<MemberRow[]>([])
const tokenInput = ref('')
const busy = ref(false)
const connectingOAuth = ref(false)

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
      for (const { type } of ROUTABLE.value) {
        routes[type] = slack.settings?.routes[type] ?? { enabled: false, channel: '' }
      }
      mentionsEnabled.value = slack.settings?.mentionsEnabled ?? false
      mapping.value = slack.memberMapping.map((e) => toMemberRow(e, nextUid()))
    } catch (e) {
      notifyError(t('slack.error.loadSettings'), e)
    }
  },
  // Lazy v-if mount: the panel mounts with `open` already true, so load immediately.
  { immediate: true },
)

async function connectViaOAuth() {
  connectingOAuth.value = true
  try {
    // On success the browser navigates away, so `connectingOAuth` never resets here —
    // it only clears on the error path below.
    window.location.href = await slack.installUrl()
  } catch (e) {
    connectingOAuth.value = false
    notifyError(t('slack.error.startOAuth'), e)
  }
}

async function connectWithToken() {
  if (!tokenInput.value.trim()) return
  try {
    await slack.connectWithToken(tokenInput.value.trim())
    tokenInput.value = ''
    toast.add({ title: t('slack.toast.connected'), icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError(t('slack.error.connect'), e)
  }
}

async function disconnect() {
  const ok = await confirm({
    title: t('slack.confirmDisconnect.title'),
    description: t('slack.confirmDisconnect.body'),
    variant: 'destructive',
    confirmLabel: t('common.disconnect'),
    icon: 'i-lucide-unplug',
  })
  if (!ok) return
  try {
    await slack.disconnect()
  } catch (e) {
    notifyError(t('slack.error.disconnect'), e)
  }
}

async function saveRouting() {
  busy.value = true
  try {
    await slack.updateSettings({
      routes: { ...routes },
      mentionsEnabled: mentionsEnabled.value,
    })
    toast.add({ title: t('slack.toast.routingSaved'), icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError(t('slack.error.saveRouting'), e)
  } finally {
    busy.value = false
  }
}

function addMapping() {
  mapping.value.push(emptyMemberRow(nextUid()))
}
function removeMapping(uid: string) {
  mapping.value = mapping.value.filter((e) => e.uid !== uid)
}
async function saveMapping() {
  // A partially-filled row (one id present, the other blank) used to be silently
  // dropped on save (UX-23) — block instead so the user doesn't lose the entry. A
  // fully-empty row is just an unused slot and is ignored.
  if (hasHalfFilledRow(mapping.value)) {
    toast.add({
      title: t('slack.members.incompleteTitle'),
      description: t('slack.members.incompleteBody'),
      icon: 'i-lucide-triangle-alert',
      color: 'warning',
    })
    return
  }
  busy.value = true
  try {
    const entries = toMemberEntries(mapping.value)
    await slack.updateMemberMapping(entries)
    mapping.value = slack.memberMapping.map((e) => toMemberRow(e, nextUid()))
    toast.add({ title: t('slack.toast.mapSaved'), icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError(t('slack.error.saveMap'), e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="t('slack.panel.title')" :ui="{ content: 'max-w-2xl' }">
    <template #title>
      <IntegrationBackTitle :title="t('slack.panel.title')" @back="back" />
    </template>
    <template #body>
      <div class="space-y-5">
        <p class="text-xs text-slate-400">
          {{ t('slack.panel.intro') }}
        </p>

        <!-- not connected: connect UI -->
        <div v-if="!slack.connected" class="space-y-3 rounded-lg border border-slate-700 p-3">
          <UButton
            v-if="slack.oauthEnabled"
            color="primary"
            icon="i-lucide-slack"
            :loading="connectingOAuth"
            @click="connectViaOAuth"
          >
            {{ t('slack.connect.addToSlack') }}
          </UButton>
          <div class="space-y-1">
            <span class="block text-[10px] uppercase tracking-wide text-slate-500">
              {{ t('slack.connect.orPasteToken') }}
            </span>
            <div class="flex gap-2">
              <SecretInput v-model="tokenInput" size="sm" class="flex-1" placeholder="xoxb-…" />
              <UButton
                color="primary"
                variant="soft"
                size="sm"
                :loading="slack.connecting"
                :disabled="!tokenInput.trim()"
                @click="connectWithToken"
              >
                {{ t('slack.connect.connect') }}
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
              <i18n-t keypath="slack.connected.label" tag="span">
                <template #team>
                  <span class="font-semibold">{{ slack.connection?.teamName }}</span>
                </template>
              </i18n-t>
            </span>
            <UButton
              color="error"
              variant="ghost"
              size="xs"
              icon="i-lucide-unplug"
              @click="disconnect"
            >
              {{ t('slack.connected.disconnect') }}
            </UButton>
          </div>

          <!-- routing -->
          <div class="space-y-3">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ t('slack.routing.heading') }}
            </p>
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
                :placeholder="t('slack.routing.channelPlaceholder')"
                :disabled="!routes[row.type]!.enabled"
                list="slack-channels"
              />
            </div>
            <datalist id="slack-channels">
              <option v-for="ch in slack.channels" :key="ch.id" :value="`#${ch.name}`" />
            </datalist>

            <label class="flex items-center gap-2">
              <USwitch v-model="mentionsEnabled" size="sm" />
              <span class="text-sm text-slate-300">{{ t('slack.routing.mentionMembers') }}</span>
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
                {{ t('slack.routing.save') }}
              </UButton>
            </div>
          </div>

          <!-- member mapping -->
          <div v-if="mentionsEnabled" class="space-y-2">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ t('slack.members.heading') }}
            </p>
            <p class="text-[11px] leading-snug text-slate-500">
              <i18n-t keypath="slack.members.hint" tag="span">
                <template #product>
                  <span class="font-medium text-slate-400">{{
                    t('slack.members.productLabel')
                  }}</span>
                </template>
              </i18n-t>
            </p>
            <div v-for="entry in mapping" :key="entry.uid" class="flex items-center gap-2">
              <UInput
                v-model="entry.userId"
                size="sm"
                class="w-40"
                :placeholder="t('slack.members.userIdPlaceholder')"
              />
              <UInput
                v-model="entry.slackUserId"
                size="sm"
                class="flex-1"
                :placeholder="t('slack.members.slackIdPlaceholder')"
              />
              <USelect
                v-model="entry.role"
                :items="ROLE_OPTIONS"
                value-key="value"
                size="sm"
                class="w-32"
              />
              <UButton
                color="error"
                variant="ghost"
                size="xs"
                icon="i-lucide-trash-2"
                @click="removeMapping(entry.uid)"
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
                {{ t('slack.members.add') }}
              </UButton>
              <UButton
                color="primary"
                variant="soft"
                size="xs"
                icon="i-lucide-save"
                :loading="busy"
                @click="saveMapping"
              >
                {{ t('slack.members.save') }}
              </UButton>
            </div>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
