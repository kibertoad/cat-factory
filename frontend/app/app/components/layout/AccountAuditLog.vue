<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { apiErrorEnvelope } from '~/composables/api/errors'
import type { AuditEventWire } from '@cat-factory/contracts'
import { actorLabel, describeEvent } from './AccountAuditLog.logic'

// The account audit log: who did what, when, for the privileged actions an account admin is
// answerable for. Read-only by construction — the store exposes no mutation and the backend has
// no update or delete surface besides the retention sweep.
//
// The whole design rests on one rule: the backend records machine-readable FIELDS and never
// prose, because a row is persisted and English written today could never be re-rendered for a
// reader in another locale years later. So every sentence here is composed from a translated key
// plus the row's `details`. The composition itself lives in `AccountAuditLog.logic.ts`, where
// the two cases a happy-path render never reaches (a retired action, an unreadable `details`
// blob) can be asserted without mounting anything.
const props = defineProps<{ accountId: string }>()

const accounts = useAccountsStore()
const toast = useToast()
const { t } = useI18n()

const events = computed(() => accounts.auditEvents)
const hasMore = computed(() => accounts.auditCursor !== null)
const loading = computed(() => accounts.auditLoading)
/**
 * The load FAILED, as distinct from an empty log. An audit viewer that renders a store outage as
 * "nothing has happened" tells an admin the exact opposite of the truth, so the two states have
 * separate renderings and this one never silently resolves to an empty list.
 */
const loadError = ref<string | null>(null)

async function load() {
  loadError.value = null
  try {
    await accounts.loadAuditEvents(props.accountId)
  } catch (e) {
    loadError.value = apiErrorEnvelope(e)?.message ?? (e instanceof Error ? e.message : String(e))
  }
}

async function loadMore() {
  try {
    await accounts.loadMoreAuditEvents(props.accountId)
  } catch (e) {
    toast.add({
      title: t('layout.auditLog.errors.loadMore'),
      description: apiErrorEnvelope(e)?.message ?? (e instanceof Error ? e.message : String(e)),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}

onMounted(() => void load())
watch(
  () => props.accountId,
  (id) => {
    if (id) void load()
  },
)
/**
 * Something elsewhere in the app wrote a row this feed does not have yet (today: an admin forcing
 * a member's sessions to end, whose only lasting trace IS that row).
 *
 * The reload lands here rather than in the writer for two reasons that are one reason: this
 * component is the only place that knows the feed is being shown, and it is the only place that
 * renders a failed read as a failed read. A writer that awaited the refresh itself would report
 * its own success or failure by whether an unrelated GET succeeded.
 */
watch(
  () => accounts.auditStale,
  (stale) => {
    if (stale) void load()
  },
)

/**
 * The composition helpers, bound to this component's i18n instance. They take `t` as a parameter
 * so the logic module stays pure and testable without an i18n runtime; binding here keeps the
 * template free of the plumbing.
 */
const describe = (event: AuditEventWire) => describeEvent(event, t)
const actor = (event: AuditEventWire) => actorLabel(event, t)

/** Absolute local time: an audit reader is answering "when exactly", never "how long ago". */
function timestamp(at: number): string {
  return new Date(at).toLocaleString()
}
</script>

<template>
  <section class="rounded-md border border-slate-800 bg-slate-800/40 p-4">
    <div class="mb-3 flex items-start justify-between gap-3">
      <div>
        <h3 class="font-semibold text-white">{{ t('layout.auditLog.title') }}</h3>
        <p class="mt-1 text-slate-400">{{ t('layout.auditLog.description') }}</p>
      </div>
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-refresh-cw"
        :loading="loading"
        :aria-label="t('layout.auditLog.refresh')"
        data-testid="audit-log-refresh"
        @click="load()"
      />
    </div>

    <!-- A failed load is NOT an empty log; it says so and offers the retry. -->
    <p v-if="loadError" class="text-red-400" data-testid="audit-log-error">
      {{ t('layout.auditLog.errors.load') }}
      <span class="text-slate-400">{{ loadError }}</span>
    </p>

    <p v-else-if="events.length === 0 && !loading" class="text-slate-400">
      {{ t('layout.auditLog.empty') }}
    </p>

    <ol v-else class="space-y-2" data-testid="audit-log-list">
      <li
        v-for="event in events"
        :key="event.id"
        class="rounded border border-slate-800 bg-slate-900/40 px-3 py-2"
      >
        <div class="flex flex-wrap items-baseline gap-x-2">
          <span class="font-medium text-white">{{ actor(event) }}</span>
          <span class="text-slate-300">{{ describe(event) }}</span>
        </div>
        <div class="mt-1 text-xs text-slate-500">{{ timestamp(event.at) }}</div>
      </li>
    </ol>

    <UButton
      v-if="hasMore && !loadError"
      class="mt-3"
      size="xs"
      color="neutral"
      variant="soft"
      :loading="loading"
      data-testid="audit-log-load-more"
      @click="loadMore()"
    >
      {{ t('layout.auditLog.loadMore') }}
    </UButton>
  </section>
</template>
