<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { apiErrorEnvelope } from '~/composables/api/errors'
import { isRetiredAuditValue } from '@cat-factory/contracts'
import type { AuditAction, AuditEventWire } from '@cat-factory/contracts'

// The account audit log: who did what, when, for the privileged actions an account admin is
// answerable for. Read-only by construction — the store exposes no mutation and the backend has
// no update or delete surface besides the retention sweep.
//
// The whole design rests on one rule: the backend records machine-readable FIELDS and never
// prose, because a row is persisted and English written today could never be re-rendered for a
// reader in another locale years later. So every sentence here is composed from a translated key
// plus the row's `details`, and the `Record` below is exhaustive over the contract's action
// picklist — a new action fails this component's typecheck until it has copy in every locale.
const props = defineProps<{ accountId: string }>()

const accounts = useAccountsStore()
const toast = useToast()
const { t } = useI18n()

/**
 * Action → message key. EXHAUSTIVE over the contract union on purpose: the alternative is a
 * lookup that returns `undefined` for an action somebody added on the backend, which renders a
 * raw `account.member_roles_changed` at an operator instead of failing the build.
 */
const ACTION_KEYS: Record<AuditAction, string> = {
  'account.member_added': 'layout.auditLog.actions.accountMemberAdded',
  'account.member_roles_changed': 'layout.auditLog.actions.accountMemberRolesChanged',
  'account.budget_changed': 'layout.auditLog.actions.accountBudgetChanged',
  'account.settings_changed': 'layout.auditLog.actions.accountSettingsChanged',
  'account.invitation_created': 'layout.auditLog.actions.accountInvitationCreated',
  'account.invitation_revoked': 'layout.auditLog.actions.accountInvitationRevoked',
  'account.invitation_accepted': 'layout.auditLog.actions.accountInvitationAccepted',
  'account.member_sessions_revoked': 'layout.auditLog.actions.accountMemberSessionsRevoked',
  'workspace.member_added': 'layout.auditLog.actions.workspaceMemberAdded',
  'workspace.member_role_changed': 'layout.auditLog.actions.workspaceMemberRoleChanged',
  'workspace.member_removed': 'layout.auditLog.actions.workspaceMemberRemoved',
  'workspace.access_mode_changed': 'layout.auditLog.actions.workspaceAccessModeChanged',
}

/**
 * The sentence for one row.
 *
 * A RETIRED action (one this build no longer declares, in a row written before it was retired)
 * is named as itself rather than dropped or guessed onto a current member. Nothing here can know
 * what it meant, and a missing row is the one failure an audit log must not have — so it renders
 * as "unrecognised action: <value>" and keeps its actor, target and timestamp.
 */
function describe(event: AuditEventWire): string {
  if (isRetiredAuditValue(event.action)) {
    return t('layout.auditLog.retiredAction', { action: event.action.retired })
  }
  return t(ACTION_KEYS[event.action], {
    target: targetLabel(event),
    // Every detail slot the vocabulary declares, defaulted so a row whose `details` blob was
    // unreadable (the backend returns an empty set rather than losing the row) still renders a
    // sentence rather than the literal `{roles}` placeholder.
    ...detailParams(event),
  })
}

/** The row's detail fields as interpolation params, with a placeholder for an absent value. */
function detailParams(event: AuditEventWire): Record<string, string> {
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(event.details)) {
    params[key] = value === null || value === '' ? t('layout.auditLog.values.none') : String(value)
  }
  return params
}

/** Who the action was performed ON: the resolved name, else the raw id. */
function targetLabel(event: AuditEventWire): string {
  return event.targetName ?? event.targetId
}

/**
 * Who performed it.
 *
 * The three principal kinds render differently on purpose. A user shows their name (or their id,
 * when the person is gone — which is precisely the kind of thing the log is kept to record); an
 * API key shows the key, never the person who minted it, so a leaked key is distinguishable from
 * them; and `system` says the engine acted, which is a different fact from a user we failed to
 * resolve and must never look the same.
 */
function actorLabel(event: AuditEventWire): string {
  if (event.actor.kind === 'system') return t('layout.auditLog.actors.system')
  if (event.actor.kind === 'apiKey') {
    return t('layout.auditLog.actors.apiKey', { id: event.actor.apiKeyId })
  }
  return event.actorName ?? event.actor.userId
}

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
          <span class="font-medium text-white">{{ actorLabel(event) }}</span>
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
