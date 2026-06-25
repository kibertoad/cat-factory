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
import type { TaskSourceKind, TrackerKind } from '~/types/domain'

const tracker = useTrackerStore()
const tasks = useTasksStore()
const ui = useUiStore()
const toast = useToast()

// --- filing tracker + writeback (one Save, persisted on tracker settings) -----
const trackerKind = ref<TrackerKind | null>(null)
const jiraProjectKey = ref('')
const commentOnPrOpen = ref(false)
const resolveOnMerge = ref(false)
const saving = ref(false)

function hydrate() {
  trackerKind.value = tracker.settings.tracker
  jiraProjectKey.value = tracker.settings.jiraProjectKey ?? ''
  commentOnPrOpen.value = tracker.settings.writebackCommentOnPrOpen
  resolveOnMerge.value = tracker.settings.writebackResolveOnMerge
}
onMounted(() => {
  hydrate()
  // The descriptors (availability + enable state) come from the task-source probe;
  // probe on open if the navbar hasn't already, so the toggles below reflect reality.
  if (tasks.available === null) void tasks.probe()
})
watch(() => tracker.settings, hydrate, { deep: true })

// Per-source live state (available = usable now; enabled = offered to the workspace).
const github = computed(() => tasks.descriptorFor('github'))
const jira = computed(() => tasks.descriptorFor('jira'))

// A tracker can only file where it can authenticate: GitHub rides the installed
// App, Jira needs a connection. Selecting an unusable tracker is allowed (it just
// won't file until set up), but we surface the gap inline.
const githubAvailable = computed(() => github.value?.available ?? false)
const jiraConnected = computed(() => tasks.isConnected('jira'))

// Jira needs a project key to file into; block Save on an empty one when picked.
const canSave = computed(
  () => trackerKind.value !== 'jira' || jiraProjectKey.value.trim().length > 0,
)

async function save() {
  if (!canSave.value) return
  saving.value = true
  try {
    await tracker.save({
      tracker: trackerKind.value,
      jiraProjectKey: trackerKind.value === 'jira' ? jiraProjectKey.value.trim() : null,
      writebackCommentOnPrOpen: commentOnPrOpen.value,
      writebackResolveOnMerge: resolveOnMerge.value,
    })
    toast.add({ title: 'Issue tracker saved', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not save settings',
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
      title: 'Could not update',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    togglingSource.value = null
  }
}
</script>

<template>
  <div class="space-y-7">
    <!-- 1. Filing tracker ----------------------------------------------------->
    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-semibold text-slate-200">Where tickets are filed</h3>
        <p class="mt-1 text-[11px] text-slate-400">
          The tech-debt recurring pipeline raises an issue before implementation and files it in
          this tracker. Choose <span class="text-slate-300">None</span> to skip filing.
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
          None
        </UButton>
        <UButton
          icon="i-lucide-github"
          size="sm"
          :color="trackerKind === 'github' ? 'primary' : 'neutral'"
          :variant="trackerKind === 'github' ? 'solid' : 'subtle'"
          @click="trackerKind = 'github'"
        >
          GitHub Issues
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
      </div>

      <!-- Inline readiness hints for the picked tracker. -->
      <p v-if="trackerKind === 'github' && !githubAvailable" class="text-[11px] text-amber-400">
        GitHub Issues rides your installed GitHub App, which isn't connected yet. Install it under
        <button class="underline" @click="ui.openGitHub()">Integrations → GitHub</button> — filing
        stays off until then.
      </p>
      <p v-else-if="trackerKind === 'jira' && !jiraConnected" class="text-[11px] text-amber-400">
        Jira isn't connected yet.
        <button class="underline" @click="ui.openTaskConnect('jira')">Connect it</button> to file
        and link issues.
      </p>

      <UFormField v-if="trackerKind === 'jira'" label="Jira project key" class="w-48">
        <UInput v-model="jiraProjectKey" placeholder="ENG" size="sm" class="w-full" />
        <template #help>
          <span class="text-[11px] text-slate-500">New tickets are filed under this project.</span>
        </template>
      </UFormField>
    </section>

    <!-- 2. Linking sources ---------------------------------------------------->
    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-semibold text-slate-200">Link issues as context</h3>
        <p class="mt-1 text-[11px] text-slate-400">
          When a source is offered you can import its issues and attach them to a task, so agents
          see the issue description and comments while implementing. This is independent of the
          filing tracker above.
        </p>
      </div>

      <!-- GitHub Issues source -->
      <div
        class="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2.5"
      >
        <div class="flex min-w-0 items-center gap-2.5">
          <UIcon name="i-lucide-github" class="h-5 w-5 shrink-0 text-slate-300" />
          <div class="min-w-0">
            <div class="text-sm font-medium text-slate-200">GitHub Issues</div>
            <div class="text-[11px] text-slate-500">
              {{
                githubAvailable
                  ? 'Rides your installed GitHub App — no credentials needed.'
                  : 'Install the GitHub App (Integrations → GitHub) to offer this source.'
              }}
            </div>
          </div>
        </div>
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
          Install
        </UButton>
      </div>

      <!-- Jira source -->
      <div
        class="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2.5"
      >
        <div class="flex min-w-0 items-center gap-2.5">
          <UIcon name="i-lucide-trello" class="h-5 w-5 shrink-0 text-slate-300" />
          <div class="min-w-0">
            <div class="text-sm font-medium text-slate-200">Jira</div>
            <div class="text-[11px] text-slate-500">
              {{ jiraConnected ? 'Connected.' : 'Connect with a Jira account and API token.' }}
            </div>
          </div>
        </div>
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
          Connect
        </UButton>
      </div>
    </section>

    <!-- 3. Writeback ---------------------------------------------------------->
    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-semibold text-slate-200">Writeback</h3>
        <p class="mt-1 text-[11px] text-slate-400">
          Write back to a task's linked issue(s) as its pull request progresses. Each toggle is the
          workspace default and can be overridden per task in the inspector. GitHub issues close
          natively; Jira issues transition to the first status in their
          <span class="text-slate-300">Done</span> category.
        </p>
      </div>

      <label class="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
        <USwitch v-model="commentOnPrOpen" />
        <span class="text-sm">
          <span class="block text-slate-200">Comment when a PR opens</span>
          <span class="block text-xs text-slate-500">
            Post a comment on the linked issue with the new pull request's link.
          </span>
        </span>
      </label>

      <label class="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
        <USwitch v-model="resolveOnMerge" />
        <span class="text-sm">
          <span class="block text-slate-200">Close as resolved when a PR merges</span>
          <span class="block text-xs text-slate-500">
            Comment that the PR merged, then close / resolve the linked issue.
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
        Save
      </UButton>
    </div>
  </div>
</template>
