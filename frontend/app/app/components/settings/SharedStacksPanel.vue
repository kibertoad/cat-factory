<script setup lang="ts">
// Shared stacks — long-lived compose infra (e.g. acme-shared-services: MySQL / Postgres /
// Valkey / RabbitMQ / Kafka / ES / Mailpit / Envoy) brought up ONCE per workspace and reused
// across runs + PRs. A per-PR consumer environment attaches to a stack's managed network. CRUD
// works on every backend; the bring-up (Start) / teardown (Stop) drive a host Docker daemon, so
// they succeed only on the local facade (elsewhere the backend returns a clear error surfaced as
// a toast). Renders inline inside the Infrastructure window's "Shared stacks" tab.
import { computed, reactive, ref } from 'vue'
import type {
  SharedStack,
  SharedStackRecommendation,
  SharedStackStatus,
} from '~/types/sharedStacks'

const { t } = useI18n()
const store = useSharedStacksStore()
const toast = useToast()
const { confirmAction, toastDone } = useConfirmAction()

const stacks = computed(() => store.stacks)
const busyId = ref<string | null>(null)
const saving = ref(false)
const detecting = ref(false)
// null ⇒ the form is in "add" mode; a stack id ⇒ editing that stack's definition in place.
const editingId = ref<string | null>(null)

const form = reactive({
  name: '',
  cloneUrl: '',
  gitRef: '',
  // Subdirectory the compose stack lives in (monorepo) — a detect-time hint only, NOT persisted:
  // the resolved `composeFiles` already carry the prefix. Absent ⇒ the repo root is scanned.
  directory: '',
  composeFiles: '',
  composeProfiles: '',
  managedNetworks: '',
  allowHostCommands: false,
})

// Env/config templates (`*-dist` → gitignored target) the autodetect scan surfaced. The form has no
// editor for them, so we carry the detected (or, on edit, the stack's existing) set through to the
// save payload rather than silently dropping them — they're materialized before `up`.
const detectedEnvFiles = ref<SharedStack['envFiles']>([])

/** Status → badge colour. */
const STATUS_COLOR: Record<SharedStackStatus, 'neutral' | 'warning' | 'success' | 'error'> = {
  stopped: 'neutral',
  starting: 'warning',
  running: 'success',
  failed: 'error',
}

// Status → catalog key as an EXHAUSTIVE Record over the enum (not a runtime-assembled key), so a
// new SharedStackStatus fails the typecheck on this map instead of leaking a raw key into the badge.
const STATUS_LABEL_KEYS: Record<SharedStackStatus, string> = {
  stopped: 'settings.sharedStacks.status.stopped',
  starting: 'settings.sharedStacks.status.starting',
  running: 'settings.sharedStacks.status.running',
  failed: 'settings.sharedStacks.status.failed',
}

function statusLabel(status: SharedStackStatus): string {
  return t(STATUS_LABEL_KEYS[status])
}

/** A running/starting stack cannot be reconfigured (the backend refuses) — edit is stopped/failed only. */
function canEdit(stack: SharedStack): boolean {
  return stack.status !== 'running' && stack.status !== 'starting'
}

/** Split a comma/whitespace-separated field into trimmed non-empty tokens. */
function tokens(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const canSave = computed(
  () => form.name.trim() && form.cloneUrl.trim() && tokens(form.composeFiles).length > 0,
)

function resetForm() {
  editingId.value = null
  form.name = ''
  form.cloneUrl = ''
  form.gitRef = ''
  form.directory = ''
  form.composeFiles = ''
  form.composeProfiles = ''
  form.managedNetworks = ''
  form.allowHostCommands = false
  detectedEnvFiles.value = []
}

/** Load a stack's definition into the form for in-place editing. */
function startEdit(stack: SharedStack) {
  editingId.value = stack.id
  form.name = stack.name
  form.cloneUrl = stack.cloneUrl
  form.gitRef = stack.gitRef ?? ''
  form.directory = ''
  form.composeFiles = stack.composeFiles.join(', ')
  form.composeProfiles = stack.composeProfiles.join(', ')
  form.managedNetworks = stack.managedNetworks.join(', ')
  form.allowHostCommands = stack.allowHostCommands
  // Preserve the stack's existing env templates so a save (or a later re-detect) doesn't drop them.
  detectedEnvFiles.value = stack.envFiles
}

const canDetect = computed(() => Boolean(form.cloneUrl.trim()) && !detecting.value)

/**
 * Read the repo at the entered clone URL (checkout-free, via the workspace's VCS connection) and
 * PREFILL the compose-shaped fields from the recommendation. Non-binding: the user reviews + edits
 * before saving. A SUCCESSFUL detection is authoritative for the compose-shaped fields — it
 * overwrites them wholesale, including clearing a field the scan found empty (so re-detecting a
 * different repo can't leave a stale managed network / profile behind). Manual entries survive only
 * a `detected:false` result, which returns early and touches nothing. The name is suggested only
 * when still blank (it's a user label, not a repo-derived fact).
 */
async function autodetect() {
  detecting.value = true
  try {
    const rec = await store.detect({
      cloneUrl: form.cloneUrl.trim(),
      ...(form.gitRef.trim() ? { gitRef: form.gitRef.trim() } : {}),
      ...(form.directory.trim() ? { directory: form.directory.trim() } : {}),
    })
    if (!rec.detected) {
      toast.add({
        title: t('settings.sharedStacks.detect.nothing'),
        description: rec.notes[0]?.message ?? '',
        icon: 'i-lucide-info',
        color: 'warning',
      })
      return
    }
    if (rec.name && !form.name.trim()) form.name = rec.name
    form.composeFiles = rec.composeFiles.join(', ')
    form.composeProfiles = rec.composeProfiles.join(', ')
    form.managedNetworks = rec.managedNetworks.join(', ')
    detectedEnvFiles.value = rec.envFiles
    toast.add({
      title: t('settings.sharedStacks.detect.detected'),
      description: t('settings.sharedStacks.detect.detectedBody'),
      icon: 'i-lucide-wand-sparkles',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('settings.sharedStacks.detect.failed'), e)
  } finally {
    detecting.value = false
  }
}

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

/** Create a new stack, or save edits to the one being edited (same form, mode toggled by `editingId`). */
async function saveStack() {
  saving.value = true
  const editing = editingId.value
  const payload = {
    name: form.name.trim(),
    cloneUrl: form.cloneUrl.trim(),
    ...(form.gitRef.trim() ? { gitRef: form.gitRef.trim() } : {}),
    composeFiles: tokens(form.composeFiles),
    composeProfiles: tokens(form.composeProfiles),
    managedNetworks: tokens(form.managedNetworks),
    envFiles: detectedEnvFiles.value,
    allowHostCommands: form.allowHostCommands,
  }
  try {
    if (editing) {
      await store.update(editing, { ...payload, gitRef: form.gitRef.trim() || null })
    } else {
      await store.create(payload)
    }
    resetForm()
    toast.add({
      title: t(
        editing ? 'settings.sharedStacks.toast.updated' : 'settings.sharedStacks.toast.created',
      ),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(
      t(
        editing
          ? 'settings.sharedStacks.toast.updateFailed'
          : 'settings.sharedStacks.toast.createFailed',
      ),
      e,
    )
  } finally {
    saving.value = false
  }
}

async function start(stack: SharedStack) {
  busyId.value = stack.id
  try {
    // ensureUp resolves 200 even on a FAILED bring-up (the record carries status/lastError), so
    // surface that as an error toast too — not only a thrown transport/unavailable error.
    const updated = await store.ensureUp(stack.id)
    if (updated.status === 'failed') {
      notifyError(t('settings.sharedStacks.toast.startFailed'), updated.lastError ?? '')
    }
  } catch (e) {
    notifyError(t('settings.sharedStacks.toast.startFailed'), e)
  } finally {
    busyId.value = null
  }
}

async function stop(stack: SharedStack) {
  busyId.value = stack.id
  try {
    await store.teardown(stack.id)
  } catch (e) {
    notifyError(t('settings.sharedStacks.toast.stopFailed'), e)
  } finally {
    busyId.value = null
  }
}

async function remove(stack: SharedStack) {
  const noun = t('settings.sharedStacks.stackNoun')
  if (!(await confirmAction('remove', noun))) return
  busyId.value = stack.id
  try {
    await store.remove(stack.id)
    toastDone('remove', noun)
  } catch (e) {
    notifyError(t('settings.sharedStacks.toast.removeFailed'), e)
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <div class="space-y-4" data-testid="shared-stacks-panel">
    <p class="text-sm text-slate-400">{{ t('settings.sharedStacks.intro') }}</p>

    <section v-if="stacks.length" class="space-y-2 rounded-lg border border-slate-700 p-3">
      <h3 class="text-sm font-semibold">{{ t('settings.sharedStacks.list.heading') }}</h3>
      <div
        v-for="stack in stacks"
        :key="stack.id"
        class="space-y-2 rounded-md border border-slate-800 px-3 py-2"
        :data-testid="`shared-stack-${stack.id}`"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0 space-y-1">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium">{{ stack.name }}</span>
              <UBadge :color="STATUS_COLOR[stack.status]" variant="soft" size="sm">
                {{ statusLabel(stack.status) }}
              </UBadge>
            </div>
            <p class="truncate text-[11px] text-slate-500">{{ stack.cloneUrl }}</p>
            <div v-if="stack.managedNetworks.length" class="flex flex-wrap gap-1">
              <UBadge
                v-for="net in stack.managedNetworks"
                :key="net"
                color="neutral"
                variant="soft"
                size="sm"
              >
                {{ net }}
              </UBadge>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <UButton
              v-if="stack.status !== 'running'"
              icon="i-lucide-play"
              size="sm"
              variant="soft"
              :loading="busyId === stack.id"
              :data-testid="`shared-stack-start-${stack.id}`"
              @click="start(stack)"
            >
              {{ t('settings.sharedStacks.list.start') }}
            </UButton>
            <UButton
              v-else
              icon="i-lucide-square"
              size="sm"
              variant="soft"
              color="warning"
              :loading="busyId === stack.id"
              :data-testid="`shared-stack-stop-${stack.id}`"
              @click="stop(stack)"
            >
              {{ t('settings.sharedStacks.list.stop') }}
            </UButton>
            <UButton
              v-if="canEdit(stack)"
              color="neutral"
              variant="ghost"
              icon="i-lucide-pencil"
              size="sm"
              :data-testid="`shared-stack-edit-${stack.id}`"
              :aria-label="t('settings.sharedStacks.list.edit')"
              @click="startEdit(stack)"
            />
            <UButton
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              size="sm"
              :loading="busyId === stack.id"
              :data-testid="`shared-stack-delete-${stack.id}`"
              :aria-label="t('settings.sharedStacks.list.remove')"
              @click="remove(stack)"
            />
          </div>
        </div>
        <p v-if="stack.lastError" class="text-[11px] text-rose-400">{{ stack.lastError }}</p>
      </div>
    </section>

    <section
      class="space-y-3 rounded-lg border border-slate-700 p-3"
      data-testid="shared-stack-form"
    >
      <h3 class="text-sm font-semibold">
        {{
          t(editingId ? 'settings.sharedStacks.edit.heading' : 'settings.sharedStacks.add.heading')
        }}
      </h3>

      <UFormField :label="t('settings.sharedStacks.add.name')">
        <UInput v-model="form.name" class="w-full" data-testid="shared-stack-name" />
      </UFormField>

      <UFormField
        :label="t('settings.sharedStacks.add.cloneUrl')"
        :help="t('settings.sharedStacks.add.cloneUrlHelp')"
      >
        <UInput
          v-model="form.cloneUrl"
          placeholder="https://github.com/acme/acme-shared-services.git"
          class="w-full"
          data-testid="shared-stack-clone-url"
        />
      </UFormField>

      <UFormField :label="t('settings.sharedStacks.add.gitRef')">
        <UInput
          v-model="form.gitRef"
          placeholder="main"
          class="w-full"
          data-testid="shared-stack-git-ref"
        />
      </UFormField>

      <UFormField
        :label="t('settings.sharedStacks.add.directory')"
        :help="t('settings.sharedStacks.add.directoryHelp')"
      >
        <UInput
          v-model="form.directory"
          placeholder="shared"
          class="w-full"
          data-testid="shared-stack-directory"
        />
      </UFormField>

      <div class="flex items-center gap-2">
        <UButton
          icon="i-lucide-wand-sparkles"
          size="sm"
          variant="soft"
          :loading="detecting"
          :disabled="!canDetect"
          data-testid="shared-stack-autodetect"
          @click="autodetect"
        >
          {{ t('settings.sharedStacks.detect.button') }}
        </UButton>
        <span class="text-[11px] text-slate-500">{{ t('settings.sharedStacks.detect.hint') }}</span>
      </div>

      <p
        v-if="detectedEnvFiles.length"
        class="text-[11px] text-slate-500"
        data-testid="shared-stack-env-files"
      >
        {{ t('settings.sharedStacks.detect.envFiles') }}
        {{ detectedEnvFiles.map((f) => `${f.template} → ${f.target}`).join(', ') }}
      </p>

      <UFormField
        :label="t('settings.sharedStacks.add.composeFiles')"
        :help="t('settings.sharedStacks.add.composeFilesHelp')"
      >
        <UInput
          v-model="form.composeFiles"
          placeholder="docker-compose.yml, docker-compose.override.yml"
          class="w-full"
          data-testid="shared-stack-compose-files"
        />
      </UFormField>

      <UFormField :label="t('settings.sharedStacks.add.composeProfiles')">
        <UInput
          v-model="form.composeProfiles"
          placeholder="backends, peer"
          class="w-full"
          data-testid="shared-stack-profiles"
        />
      </UFormField>

      <UFormField
        :label="t('settings.sharedStacks.add.managedNetworks')"
        :help="t('settings.sharedStacks.add.managedNetworksHelp')"
      >
        <UInput
          v-model="form.managedNetworks"
          placeholder="acme-net"
          class="w-full"
          data-testid="shared-stack-networks"
        />
      </UFormField>

      <UCheckbox
        v-model="form.allowHostCommands"
        :label="t('settings.sharedStacks.add.allowHostCommands')"
        data-testid="shared-stack-allow-host-commands"
      />

      <div class="flex items-center gap-2">
        <UButton
          :loading="saving"
          :disabled="!canSave"
          data-testid="shared-stack-save"
          @click="saveStack"
        >
          {{ t(editingId ? 'settings.sharedStacks.edit.save' : 'settings.sharedStacks.add.save') }}
        </UButton>
        <UButton
          v-if="editingId"
          color="neutral"
          variant="ghost"
          data-testid="shared-stack-cancel-edit"
          @click="resetForm"
        >
          {{ t('settings.sharedStacks.edit.cancel') }}
        </UButton>
      </div>
    </section>
  </div>
</template>
