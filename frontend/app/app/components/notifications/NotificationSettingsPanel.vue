<script setup lang="ts">
// The notification manager: which notification types this board delivers on which channel.
//
// One row per notification type, one switch per routed channel. The switches render the
// RESOLVED routing (a workspace's override, else the shipped default) through the same
// `isNotificationRouted` the delivery path uses, so what the toggle says is what the engine
// does. Saving writes only the cells that differ from their default, which is what makes
// "put this back the way it ships" expressible at all — and what lets a later change to a
// default reach every board that never opted out of it.
//
// Slack and the outbound webhooks are deliberately absent: each answers "which types" where
// its DESTINATION is declared (a Slack route's channel, a webhook endpoint's own filter), so
// a second switch here would be a place to look that does not decide. The footer says so and
// links to the Slack panel.
import { computed, reactive, ref, watch } from 'vue'
import {
  NOTIFICATION_DELIVERY_CHANNELS,
  defaultNotificationRoute,
  isNotificationRouted,
  notificationTypeSchema,
} from '@cat-factory/contracts'
import type {
  NotificationDeliveryChannel,
  NotificationRoutingMatrix,
  NotificationType,
} from '~/types/notifications'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const ui = useUiStore()
const notifications = useNotificationsStore()
const slack = useSlackStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { t } = useI18n()

const open = computed({
  get: () => ui.notificationSettingsOpen,
  set: (v: boolean) => (v ? ui.openNotificationSettings() : ui.closeNotificationSettings()),
})
const back = useIntegrationBack(open)

/**
 * Every notification type, in the picklist's own order, taken from the SCHEMA rather than a
 * hand-kept list: a type added to the vocabulary appears here with its shipped default instead
 * of being invisible to the only surface that can change it.
 */
const TYPES = notificationTypeSchema.options as readonly NotificationType[]

/** The editable grid: `resolved[type][channel]` is the switch's state. */
const resolved = reactive(
  Object.fromEntries(
    TYPES.map((type) => [
      type,
      Object.fromEntries(
        NOTIFICATION_DELIVERY_CHANNELS.map((channel) => [
          channel,
          defaultNotificationRoute(type, channel),
        ]),
      ) as Record<NotificationDeliveryChannel, boolean>,
    ]),
  ) as Record<NotificationType, Record<NotificationDeliveryChannel, boolean>>,
)

const busy = ref(false)

function applyMatrix(matrix: NotificationRoutingMatrix | null | undefined) {
  for (const type of TYPES) {
    for (const channel of NOTIFICATION_DELIVERY_CHANNELS) {
      resolved[type][channel] = isNotificationRouted(matrix, type, channel)
    }
  }
}

/**
 * The grid is editable only once the board's OWN matrix is in hand.
 *
 * The switches start on the shipped defaults, which is right while loading and wrong as a
 * statement about the board: on a failed read the panel used to render them as the current
 * configuration, and save is a full replace, so one press would write that guess over whatever
 * overrides were stored. `failed` therefore gets its own state with a retry and no save, kept
 * distinct from the settled `unavailable`.
 */
const editable = computed(() => notifications.settingsStatus === 'ready')

async function load() {
  try {
    await notifications.loadSettings()
    applyMatrix(notifications.settings?.matrix)
  } catch (e) {
    present(e, 'notificationSettings.error.load')
  }
}

watch(
  () => open.value,
  async (isOpen) => {
    if (!isOpen) return
    await load()
  },
  // Lazy v-if mount: the panel mounts with `open` already true, so load immediately.
  { immediate: true },
)

async function save() {
  // Store only what DIFFERS from the shipped default. A full grid would freeze today's
  // defaults onto every board that saved once, so a later change to what "high impact" means
  // would reach nobody who had ever opened this panel.
  const matrix: NotificationRoutingMatrix = {}
  for (const type of TYPES) {
    const overrides: Partial<Record<NotificationDeliveryChannel, boolean>> = {}
    for (const channel of NOTIFICATION_DELIVERY_CHANNELS) {
      if (resolved[type][channel] !== defaultNotificationRoute(type, channel)) {
        overrides[channel] = resolved[type][channel]
      }
    }
    if (Object.keys(overrides).length > 0) matrix[type] = overrides
  }
  busy.value = true
  try {
    await notifications.updateSettings(matrix)
    toast.add({
      title: t('notificationSettings.toast.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'notificationSettings.error.save')
  } finally {
    busy.value = false
  }
}

/** Restore every type to its shipped routing (the switches; nothing is written until save). */
function resetToDefaults() {
  applyMatrix({})
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('notificationSettings.panel.title')"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #title>
      <IntegrationBackTitle :title="t('notificationSettings.panel.title')" @back="back" />
    </template>
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-slate-400">{{ t('notificationSettings.panel.intro') }}</p>

        <div
          v-if="notifications.settingsStatus === 'unavailable'"
          class="rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-xs text-slate-400"
        >
          {{ t('notificationSettings.unavailable') }}
        </div>

        <div
          v-else-if="notifications.settingsStatus === 'failed'"
          class="space-y-3 rounded-lg border border-amber-700/60 bg-amber-950/30 p-3 text-xs text-amber-200"
        >
          <p>{{ t('notificationSettings.loadFailed') }}</p>
          <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-rotate-cw" @click="load">
            {{ t('common.retry') }}
          </UButton>
        </div>

        <div
          v-else-if="!editable"
          class="rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-xs text-slate-400"
        >
          {{ t('common.loading') }}
        </div>

        <template v-else>
          <div
            class="flex items-center gap-3 px-2 text-[10px] uppercase tracking-wide text-slate-500"
          >
            <span class="flex-1">{{ t('notificationSettings.column.event') }}</span>
            <span class="w-16 text-center">{{ t('notificationSettings.column.inApp') }}</span>
            <span class="w-16 text-center">{{ t('notificationSettings.column.email') }}</span>
          </div>

          <div class="max-h-[50vh] space-y-1 overflow-y-auto pr-1">
            <div
              v-for="type in TYPES"
              :key="type"
              class="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/40 p-2"
            >
              <span class="flex-1 text-sm text-slate-300">
                {{ t(`notificationSettings.type.${type}`) }}
              </span>
              <div class="flex w-16 justify-center">
                <USwitch v-model="resolved[type]!.in_app" size="sm" />
              </div>
              <div class="flex w-16 justify-center">
                <USwitch v-model="resolved[type]!.email" size="sm" />
              </div>
            </div>
          </div>

          <p class="text-[11px] text-slate-500">{{ t('notificationSettings.panel.inAppNote') }}</p>
          <p class="text-[11px] text-slate-500">{{ t('notificationSettings.panel.emailNote') }}</p>
          <p class="text-[11px] text-slate-500">
            {{ t('notificationSettings.panel.otherChannelsNote') }}
            <UButton
              v-if="slack.available"
              color="neutral"
              variant="link"
              size="xs"
              class="px-1"
              @click="ui.openSlack()"
            >
              {{ t('notificationSettings.panel.openSlack') }}
            </UButton>
          </p>

          <div class="flex justify-between">
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-rotate-ccw"
              @click="resetToDefaults"
            >
              {{ t('notificationSettings.action.reset') }}
            </UButton>
            <UButton
              color="primary"
              variant="soft"
              size="xs"
              icon="i-lucide-save"
              :loading="busy || notifications.savingSettings"
              @click="save"
            >
              {{ t('notificationSettings.action.save') }}
            </UButton>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
