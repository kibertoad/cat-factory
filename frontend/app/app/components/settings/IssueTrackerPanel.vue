<script setup lang="ts">
// Workspace settings: a single, first-class home for issue tracking. It gathers
// the three things that used to be scattered (and, for the filing tracker, were
// only reachable buried inside the tech-debt recurring-pipeline modal):
//
//   1. Filing tracker — which tracker the tech-debt pipeline's `tracker` step
//      files its ticket in (GitHub Issues / Jira / none).
//   2. Linking sources — the per-workspace on/off toggle for each source
//      (task_source_settings) that governs whether issues can be imported and
//      linked to tasks as agent context.
//   3. Writeback — comment on a task's linked issue when its PR opens, and
//      comment + close it when the PR merges.
//
// Filing and linking are independent (filing rides the App / Jira connection
// directly; linking is the source toggle), so both are shown explicitly to undo
// the common confusion that "I have the GitHub App, why is nothing surfaced?".
import { computed, onMounted, ref, watch } from 'vue'
import type { TaskSourceDiagnosticStatus, TaskSourceKind, TrackerKind } from '~/types/domain'

const { t } = useI18n()
const tracker = useTrackerStore()
const tasks = useTasksStore()
const ui = useUiStore()
const toast = useToast()

// --- filing tracker + writeback (one Save, persisted on tracker settings) -----
const trackerKind = ref<TrackerKind | null>(null)
const jiraProjectKey = ref('')
const linearTeamId = ref('')
const commentOnPrOpen = ref(false)
const resolveOnMerge = ref(false)
const saving = ref(false)

function hydrate() {
  trackerKind.value = tracker.settings.tracker
  jiraProjectKey.value = tracker.settings.jiraProjectKey ?? ''
  linearTeamId.value = tracker.settings.linearTeamId ?? ''
  commentOnPrOpen.value = tracker.settings.writebackCommentOnPrOpen
  resolveOnMerge.value = tracker.settings.writebackResolveOnMerge
}
onMounted(() => {
  hydrate()
  // The descriptors (availability + enable state) come from the task-source probe;
  // probe on open if the navbar hasn't already, so the toggles below reflect reality.
  if (tasks.available === null) void tasks.probe()
})
// `tracker.settings` is reassigned wholesale on hydrate/save, so a reference watch
// (no deep traversal) catches every change.
watch(() => tracker.settings, hydrate)

// Per-source live state (available = usable now; enabled = offered to the workspace).
const github = computed(() => tasks.descriptorFor('github'))
const jira = computed(() => tasks.descriptorFor('jira'))
const linear = computed(() => tasks.descriptorFor('linear'))

// A tracker can only file where it can authenticate: GitHub rides the installed
// App, Jira/Linear need a connection. Selecting an unusable tracker is allowed (it
// just won't file until set up), but we surface the gap inline.
const githubAvailable = computed(() => github.value?.available ?? false)
const jiraConnected = computed(() => tasks.isConnected('jira'))
const linearConnected = computed(() => tasks.isConnected('linear'))

// Jira needs a project key and Linear needs a team id to file into; block Save on
// an empty one when that tracker is picked.
const canSave = computed(() => {
  if (trackerKind.value === 'jira') return jiraProjectKey.value.trim().length > 0
  if (trackerKind.value === 'linear') return linearTeamId.value.trim().length > 0
  return true
})

// Linear team picker: load the connected workspace's teams so filing offers a
// dropdown instead of a raw team-id paste. Falls back to the text input if the
// teams can't be loaded (a broken connection shouldn't block configuration).
const teamsLoading = ref(false)
const teamsError = ref(false)
const teamOptions = computed(() =>
  tracker.linearTeams.map((tm) => ({
    label: tm.key ? `${tm.name} (${tm.key})` : tm.name,
    value: tm.id,
  })),
)
async function loadLinearTeams() {
  if (!linearConnected.value) return
  teamsLoading.value = true
  teamsError.value = false
  try {
    await tracker.loadLinearTeams()
  } catch {
    teamsError.value = true
  } finally {
    teamsLoading.value = false
  }
}
watch(
  () => [trackerKind.value, linearConnected.value] as const,
  ([kind, connected]) => {
    if (kind === 'linear' && connected && tracker.linearTeams.length === 0 && !teamsError.value) {
      void loadLinearTeams()
    }
  },
  { immediate: true },
)

async function save() {
  if (!canSave.value) return
  saving.value = true
  try {
    await tracker.save({
      tracker: trackerKind.value,
      jiraProjectKey: trackerKind.value === 'jira' ? jiraProjectKey.value.trim() : null,
      linearTeamId: trackerKind.value === 'linear' ? linearTeamId.value.trim() : null,
      writebackCommentOnPrOpen: commentOnPrOpen.value,
      writebackResolveOnMerge: resolveOnMerge.value,
    })
    toast.add({
      title: t('settings.issueTracker.toast.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('settings.issueTracker.toast.saveFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}

// --- linking sources (per-source toggle, saved immediately) -------------------
const togglingSource = ref<TaskSourceKind | null>(null)

async function toggleSource(source: TaskSourceKind, enabled: boolean) {
  togglingSource.value = source
  try {
    await tasks.setEnabled(source, enabled)
  } catch (e) {
    toast.add({
      title: t('settings.issueTracker.toast.updateFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    togglingSource.value = null
  }
}

// --- live "check setup" -------------------------------------------------------
// The probe failed entirely (not a per-source state): the whole integration is
// off or the backend errored, so the panel can't show real source state. We
// translate the captured status into a plain explanation + next step.
const probeFailureHint = computed(() => {
  const err = tasks.probeError
  if (tasks.available !== false || !err) return null
  if (err.status === 503) {
    return t('settings.issueTracker.probeFailure.disabled')
  }
  if (err.status && err.status >= 500) {
    return t('settings.issueTracker.probeFailure.serverError', {
      status: err.status,
      message: err.message,
    })
  }
  return err.status
    ? t('settings.issueTracker.probeFailure.loadFailedStatus', {
        status: err.status,
        message: err.message,
      })
    : t('settings.issueTracker.probeFailure.loadFailed', { message: err.message })
})

async function checkSetup(source: TaskSourceKind) {
  try {
    await tasks.checkSetup(source)
  } catch (e) {
    toast.add({
      title: t('settings.issueTracker.toast.checkFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}

// Status → presentation for a setup-check verdict.
const STATUS_UI: Record<
  TaskSourceDiagnosticStatus,
  { color: 'success' | 'warning' | 'error' | 'neutral'; icon: string }
> = {
  ready: { color: 'success', icon: 'i-lucide-circle-check' },
  not_installed: { color: 'warning', icon: 'i-lucide-download' },
  not_connected: { color: 'warning', icon: 'i-lucide-plug' },
  auth_failed: { color: 'error', icon: 'i-lucide-key-round' },
  forbidden: { color: 'error', icon: 'i-lucide-shield-x' },
  unreachable: { color: 'error', icon: 'i-lucide-wifi-off' },
  error: { color: 'error', icon: 'i-lucide-triangle-alert' },
}
</script>

<template>
  <div class="space-y-7">
    <!-- Whole-integration failure: explain WHY nothing is surfaced, instead of the
         passive per-source "install first" hints (which would be misleading here). -->
    <UAlert
      v-if="probeFailureHint"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('settings.issueTracker.probeFailure.title')"
      :description="probeFailureHint"
    />

    <!-- 1. Filing tracker ----------------------------------------------------->
    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-semibold text-slate-200">
          {{ t('settings.issueTracker.filing.heading') }}
        </h3>
        <p class="mt-1 text-[11px] text-slate-400">
          <i18n-t keypath="settings.issueTracker.filing.description" tag="span" scope="global">
            <template #none>
              <span class="text-slate-300">{{ t('settings.issueTracker.filing.none') }}</span>
            </template>
          </i18n-t>
        </p>
      </div>

      <div class="flex flex-wrap gap-2">
        <UButton
          icon="i-lucide-circle-slash"
          size="sm"
          :color="trackerKind === null ? 'primary' : 'neutral'"
          :variant="trackerKind === null ? 'solid' : 'subtle'"
          @click="trackerKind = null"
        >
          {{ t('settings.issueTracker.filing.none') }}
        </UButton>
        <UButton
          icon="i-lucide-github"
          size="sm"
          :color="trackerKind === 'github' ? 'primary' : 'neutral'"
          :variant="trackerKind === 'github' ? 'solid' : 'subtle'"
          @click="trackerKind = 'github'"
        >
          {{ t('settings.issueTracker.vendor.github') }}
        </UButton>
        <UButton
          icon="i-lucide-trello"
          size="sm"
          :color="trackerKind === 'jira' ? 'primary' : 'neutral'"
          :variant="trackerKind === 'jira' ? 'solid' : 'subtle'"
          @click="trackerKind = 'jira'"
        >
          Jira
        </UButton>
        <UButton
          icon="i-lucide-square-kanban"
          size="sm"
          :color="trackerKind === 'linear' ? 'primary' : 'neutral'"
          :variant="trackerKind === 'linear' ? 'solid' : 'subtle'"
          @click="trackerKind = 'linear'"
        >
          Linear
        </UButton>
      </div>

      <!-- Inline readiness hints for the picked tracker. -->
      <p v-if="trackerKind === 'github' && !githubAvailable" class="text-[11px] text-amber-400">
        <i18n-t keypath="settings.issueTracker.filing.githubHint" tag="span" scope="global">
          <template #link>
            <button class="underline" @click="ui.openGitHub()">
              {{ t('settings.issueTracker.filing.githubHintLink') }}
            </button>
          </template>
        </i18n-t>
      </p>
      <p v-else-if="trackerKind === 'jira' && !jiraConnected" class="text-[11px] text-amber-400">
        <i18n-t keypath="settings.issueTracker.filing.jiraHint" tag="span" scope="global">
          <template #link>
            <button class="underline" @click="ui.openTaskConnect('jira')">
              {{ t('settings.issueTracker.filing.connectLink') }}
            </button>
          </template>
        </i18n-t>
      </p>
      <p
        v-else-if="trackerKind === 'linear' && !linearConnected"
        class="text-[11px] text-amber-400"
      >
        <i18n-t keypath="settings.issueTracker.filing.linearHint" tag="span" scope="global">
          <template #link>
            <button class="underline" @click="ui.openTaskConnect('linear')">
              {{ t('settings.issueTracker.filing.connectLink') }}
            </button>
          </template>
        </i18n-t>
      </p>

      <UFormField
        v-if="trackerKind === 'jira'"
        :label="t('settings.issueTracker.filing.jiraProjectKey')"
        class="w-48"
      >
        <UInput v-model="jiraProjectKey" placeholder="ENG" size="sm" class="w-full" />
        <template #help>
          <span class="text-[11px] text-slate-500">
            {{ t('settings.issueTracker.filing.jiraProjectKeyHelp') }}
          </span>
        </template>
      </UFormField>

      <UFormField
        v-if="trackerKind === 'linear'"
        :label="t('settings.issueTracker.filing.linearTeamId')"
        class="w-64"
      >
        <!-- Picker when the connection's teams loaded; raw-id fallback otherwise. -->
        <USelect
          v-if="linearConnected && !teamsError && teamOptions.length > 0"
          v-model="linearTeamId"
          :items="teamOptions"
          value-key="value"
          :loading="teamsLoading"
          :placeholder="t('settings.issueTracker.filing.linearTeamPlaceholder')"
          size="sm"
          class="w-full"
        />
        <UInput v-else v-model="linearTeamId" placeholder="team_…" size="sm" class="w-full" />
        <template #help>
          <span class="text-[11px] text-slate-500">
            {{ t('settings.issueTracker.filing.linearTeamIdHelp') }}
          </span>
        </template>
      </UFormField>
    </section>

    <!-- 2. Linking sources ---------------------------------------------------->
    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-semibold text-slate-200">
          {{ t('settings.issueTracker.linking.heading') }}
        </h3>
        <p class="mt-1 text-[11px] text-slate-400">
          {{ t('settings.issueTracker.linking.description') }}
        </p>
      </div>

      <!-- GitHub Issues source -->
      <div class="rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2.5">
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2.5">
            <UIcon name="i-lucide-github" class="h-5 w-5 shrink-0 text-slate-300" />
            <div class="min-w-0">
              <div class="text-sm font-medium text-slate-200">
                {{ t('settings.issueTracker.vendor.github') }}
              </div>
              <div class="text-[11px] text-slate-500">
                {{
                  githubAvailable
                    ? t('settings.issueTracker.linking.github.available')
                    : t('settings.issueTracker.linking.github.unavailable')
                }}
              </div>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-stethoscope"
              :loading="tasks.checking === 'github'"
              @click="checkSetup('github')"
            >
              {{ t('settings.issueTracker.linking.checkSetup') }}
            </UButton>
            <USwitch
              v-if="githubAvailable"
              :model-value="github?.enabled ?? false"
              :loading="togglingSource === 'github'"
              @update:model-value="(v: boolean) => toggleSource('github', v)"
            />
            <UButton
              v-else
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-github"
              @click="ui.openGitHub()"
            >
              {{ t('settings.issueTracker.linking.install') }}
            </UButton>
          </div>
        </div>
        <UAlert
          v-if="tasks.diagnostics.github"
          class="mt-2.5"
          :color="STATUS_UI[tasks.diagnostics.github.status].color"
          variant="subtle"
          :icon="STATUS_UI[tasks.diagnostics.github.status].icon"
          :description="
            tasks.diagnostics.github.message +
            (tasks.diagnostics.github.detail ? ` ${tasks.diagnostics.github.detail}` : '')
          "
          :ui="{ description: 'text-[11px]' }"
        />
      </div>

      <!-- Jira source -->
      <div class="rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2.5">
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2.5">
            <UIcon name="i-lucide-trello" class="h-5 w-5 shrink-0 text-slate-300" />
            <div class="min-w-0">
              <div class="text-sm font-medium text-slate-200">
                {{ t('settings.issueTracker.vendor.jira') }}
              </div>
              <div class="text-[11px] text-slate-500">
                {{
                  jiraConnected
                    ? t('settings.issueTracker.linking.connected')
                    : t('settings.issueTracker.linking.jira.connectHint')
                }}
              </div>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <UButton
              v-if="jiraConnected"
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-stethoscope"
              :loading="tasks.checking === 'jira'"
              @click="checkSetup('jira')"
            >
              {{ t('settings.issueTracker.linking.checkSetup') }}
            </UButton>
            <USwitch
              v-if="jira?.available"
              :model-value="jira?.enabled ?? false"
              :loading="togglingSource === 'jira'"
              @update:model-value="(v: boolean) => toggleSource('jira', v)"
            />
            <UButton
              v-else
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-plug"
              @click="ui.openTaskConnect('jira')"
            >
              {{ t('settings.issueTracker.linking.connect') }}
            </UButton>
          </div>
        </div>
        <UAlert
          v-if="tasks.diagnostics.jira"
          class="mt-2.5"
          :color="STATUS_UI[tasks.diagnostics.jira.status].color"
          variant="subtle"
          :icon="STATUS_UI[tasks.diagnostics.jira.status].icon"
          :description="
            tasks.diagnostics.jira.message +
            (tasks.diagnostics.jira.detail ? ` ${tasks.diagnostics.jira.detail}` : '')
          "
          :ui="{ description: 'text-[11px]' }"
        />
      </div>

      <!-- Linear source -->
      <div class="rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2.5">
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2.5">
            <UIcon name="i-lucide-square-kanban" class="h-5 w-5 shrink-0 text-slate-300" />
            <div class="min-w-0">
              <div class="text-sm font-medium text-slate-200">
                {{ t('settings.issueTracker.vendor.linear') }}
              </div>
              <div class="text-[11px] text-slate-500">
                {{
                  linearConnected
                    ? t('settings.issueTracker.linking.connected')
                    : t('settings.issueTracker.linking.linear.connectHint')
                }}
              </div>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <UButton
              v-if="linearConnected"
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-stethoscope"
              :loading="tasks.checking === 'linear'"
              @click="checkSetup('linear')"
            >
              {{ t('settings.issueTracker.linking.checkSetup') }}
            </UButton>
            <USwitch
              v-if="linear?.available"
              :model-value="linear?.enabled ?? false"
              :loading="togglingSource === 'linear'"
              @update:model-value="(v: boolean) => toggleSource('linear', v)"
            />
            <UButton
              v-else
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-plug"
              @click="ui.openTaskConnect('linear')"
            >
              {{ t('settings.issueTracker.linking.connect') }}
            </UButton>
          </div>
        </div>
        <UAlert
          v-if="tasks.diagnostics.linear"
          class="mt-2.5"
          :color="STATUS_UI[tasks.diagnostics.linear.status].color"
          variant="subtle"
          :icon="STATUS_UI[tasks.diagnostics.linear.status].icon"
          :description="
            tasks.diagnostics.linear.message +
            (tasks.diagnostics.linear.detail ? ` ${tasks.diagnostics.linear.detail}` : '')
          "
          :ui="{ description: 'text-[11px]' }"
        />
      </div>
    </section>

    <!-- 3. Writeback ---------------------------------------------------------->
    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-semibold text-slate-200">
          {{ t('settings.issueTracker.writeback.heading') }}
        </h3>
        <p class="mt-1 text-[11px] text-slate-400">
          <i18n-t keypath="settings.issueTracker.writeback.description" tag="span" scope="global">
            <template #done>
              <span class="text-slate-300">{{ t('settings.issueTracker.writeback.done') }}</span>
            </template>
          </i18n-t>
        </p>
      </div>

      <label class="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
        <USwitch v-model="commentOnPrOpen" />
        <span class="text-sm">
          <span class="block text-slate-200">
            {{ t('settings.issueTracker.writeback.commentOnOpen.label') }}
          </span>
          <span class="block text-xs text-slate-500">
            {{ t('settings.issueTracker.writeback.commentOnOpen.help') }}
          </span>
        </span>
      </label>

      <label class="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
        <USwitch v-model="resolveOnMerge" />
        <span class="text-sm">
          <span class="block text-slate-200">
            {{ t('settings.issueTracker.writeback.resolveOnMerge.label') }}
          </span>
          <span class="block text-xs text-slate-500">
            {{ t('settings.issueTracker.writeback.resolveOnMerge.help') }}
          </span>
        </span>
      </label>
    </section>

    <div class="flex justify-end">
      <UButton
        color="primary"
        icon="i-lucide-save"
        size="sm"
        :loading="saving"
        :disabled="!canSave"
        @click="save"
      >
        {{ t('common.save') }}
      </UButton>
    </div>
  </div>
</template>
