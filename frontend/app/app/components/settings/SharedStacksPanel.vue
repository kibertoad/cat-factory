<script setup lang="ts">
// Shared stacks — long-lived compose infra (e.g. acme-shared-services: MySQL / Postgres /
// Valkey / RabbitMQ / Kafka / ES / Mailpit / Envoy) brought up ONCE per workspace and reused
// across runs + PRs. A per-PR consumer environment attaches to a stack's managed network. CRUD
// works on every backend; the bring-up (Start) / teardown (Stop) drive a host Docker daemon, so
// they succeed only on the local facade (elsewhere the backend returns a clear error surfaced as
// a toast). Renders inline inside the Infrastructure window's "Shared stacks" tab.
import { computed, reactive, ref } from 'vue'
import type { SharedStack, SharedStackStatus } from '~/types/sharedStacks'

const { t } = useI18n()
const store = useSharedStacksStore()
const toast = useToast()
const { confirmAction, toastDone } = useConfirmAction()

const stacks = computed(() => store.stacks)
const busyId = ref<string | null>(null)
const creating = ref(false)

const form = reactive({
  name: '',
  cloneUrl: '',
  gitRef: '',
  composeFiles: '',
  composeProfiles: '',
  managedNetworks: '',
  allowHostCommands: false,
})

/** Status → badge colour. */
const STATUS_COLOR: Record<SharedStackStatus, 'neutral' | 'warning' | 'success' | 'error'> = {
  stopped: 'neutral',
  starting: 'warning',
  running: 'success',
  failed: 'error',
}

function statusLabel(status: SharedStackStatus): string {
  return t(`settings.sharedStacks.status.${status}`)
}

/** Split a comma/whitespace-separated field into trimmed non-empty tokens. */
function tokens(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const canCreate = computed(
  () => form.name.trim() && form.cloneUrl.trim() && tokens(form.composeFiles).length > 0,
)

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

async function createStack() {
  creating.value = true
  try {
    await store.create({
      name: form.name.trim(),
      cloneUrl: form.cloneUrl.trim(),
      ...(form.gitRef.trim() ? { gitRef: form.gitRef.trim() } : {}),
      composeFiles: tokens(form.composeFiles),
      composeProfiles: tokens(form.composeProfiles),
      managedNetworks: tokens(form.managedNetworks),
      allowHostCommands: form.allowHostCommands,
    })
    form.name = ''
    form.cloneUrl = ''
    form.gitRef = ''
    form.composeFiles = ''
    form.composeProfiles = ''
    form.managedNetworks = ''
    form.allowHostCommands = false
    toast.add({
      title: t('settings.sharedStacks.toast.created'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('settings.sharedStacks.toast.createFailed'), e)
  } finally {
    creating.value = false
  }
}

async function start(stack: SharedStack) {
  busyId.value = stack.id
  try {
    await store.ensureUp(stack.id)
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

    <section class="space-y-3 rounded-lg border border-slate-700 p-3">
      <h3 class="text-sm font-semibold">{{ t('settings.sharedStacks.add.heading') }}</h3>

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

      <UButton
        :loading="creating"
        :disabled="!canCreate"
        data-testid="shared-stack-save"
        @click="createStack"
      >
        {{ t('settings.sharedStacks.add.save') }}
      </UButton>
    </section>
  </div>
</template>
