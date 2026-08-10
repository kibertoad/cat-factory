<script setup lang="ts">
// The `cloudflare` provision type's infra handler (the workspace "how"): the Cloudflare
// account's workers.dev subdomain, the VCS API token, and the two name templates that are the
// contract with the target repository's preview workflow.
//
// A SELF-CONTAINED section rather than another branch of InfraHandlersConfigurator: that file
// already carries three provision types at ~600 lines, and a fourth inline would push it well
// past the point where any single type is findable. It owns its own save/remove/test so the
// configurator gains exactly one line.
//
// There is deliberately no per-user (local-mode) override here, unlike kubernetes: a Cloudflare
// preview is built by CI and lives in the cloud, so "this machine only" has no meaning for it.
import { computed, ref, watch } from 'vue'
import type { InfraHandlerConfig } from '@cat-factory/contracts'

type CloudflareHandlerConfig = Extract<InfraHandlerConfig, { engine: 'cloudflare' }>
type CloudflareConfig = CloudflareHandlerConfig['cloudflare']

const { t } = useI18n()
const infra = useInfraConfigStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { confirmAction } = useConfirmAction()

const busy = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; message?: string } | null>(null)
const editing = ref(false)

const handler = computed(() => infra.handlerFor('cloudflare') ?? null)

// The form state. `label` is prefilled so an operator who fills in only the subdomain still
// produces a valid config; the two templates are left EMPTY on purpose — blank means "use the
// reference workflow's naming", and showing the defaults as placeholders rather than values
// keeps an untouched handler from pinning a shape it never chose.
const label = ref('Cloudflare Workers preview')
const workersSubdomain = ref('')
const repo = ref('')
const apiBaseUrl = ref('')
const workerNameTemplate = ref('')
const environmentNameTemplate = ref('')
const token = ref('')

// Prefill from the saved handler whenever it (re)loads, so re-opening the form edits the
// stored config instead of silently starting from blank and overwriting it on save. The token
// is never echoed back by the API, so it stays empty — see `secretsForSave`.
watch(
  handler,
  (h) => {
    const cfg = (h?.config as CloudflareHandlerConfig | undefined)?.cloudflare
    if (!cfg) return
    label.value = cfg.label
    workersSubdomain.value = cfg.workersSubdomain
    repo.value = cfg.repo ?? ''
    apiBaseUrl.value = cfg.apiBaseUrl ?? ''
    workerNameTemplate.value = cfg.workerNameTemplate ?? ''
    environmentNameTemplate.value = cfg.environmentNameTemplate ?? ''
  },
  { immediate: true },
)

const canSave = computed(() => workersSubdomain.value.trim() !== '' && label.value.trim() !== '')

function buildConfig(): CloudflareHandlerConfig {
  const trimmed = (value: string) => value.trim()
  const cloudflare: CloudflareConfig = {
    label: trimmed(label.value),
    workersSubdomain: trimmed(workersSubdomain.value),
    // Every optional field is OMITTED when blank rather than sent as an empty string: the
    // contract's optionals mean "fall back to the default", and an empty string would fail
    // the schema's own minLength/regex checks instead.
    ...(trimmed(repo.value) ? { repo: trimmed(repo.value) } : {}),
    ...(trimmed(apiBaseUrl.value) ? { apiBaseUrl: trimmed(apiBaseUrl.value) } : {}),
    ...(trimmed(workerNameTemplate.value)
      ? { workerNameTemplate: trimmed(workerNameTemplate.value) }
      : {}),
    ...(trimmed(environmentNameTemplate.value)
      ? { environmentNameTemplate: trimmed(environmentNameTemplate.value) }
      : {}),
  }
  return { engine: 'cloudflare', cloudflare }
}

/**
 * An UNTOUCHED token field on an already-connected handler sends no secret, so the stored one
 * is kept. Sending `''` would clear it and leave the handler unable to authenticate.
 */
function secretsForSave(): Record<string, string> {
  const value = token.value.trim()
  return value ? { githubToken: value } : {}
}

async function save() {
  if (!canSave.value) return
  busy.value = true
  try {
    await infra.registerHandler({
      provisionType: 'cloudflare',
      config: buildConfig(),
      secrets: secretsForSave(),
    })
    token.value = ''
    editing.value = false
    toast.add({
      title: t('settings.infrastructure.handler.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'settings.infrastructure.handler.saveFailed')
  } finally {
    busy.value = false
  }
}

async function test() {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await infra.testHandler({
      config: buildConfig(),
      secrets: secretsForSave(),
    })
  } catch (e) {
    testResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    testing.value = false
  }
}

async function remove() {
  if (!(await confirmAction('remove', t('settings.infrastructure.handler.cloudflareNoun')))) return
  busy.value = true
  try {
    await infra.unregisterHandler('cloudflare')
    toast.add({ title: t('settings.infrastructure.handler.removed'), icon: 'i-lucide-check' })
  } catch (e) {
    present(e, 'settings.infrastructure.handler.saveFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="space-y-2 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
    <h3 class="text-sm font-semibold text-slate-200">
      {{ t('inspector.testConfig.provisionTypes.cloudflare') }}
    </h3>
    <p class="text-[11px] text-slate-400">
      {{ t('settings.infrastructure.cloudflare.intro') }}
    </p>

    <div
      v-if="handler && !editing"
      class="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5"
      data-testid="cloudflare-handler-connected"
    >
      <div class="flex items-start justify-between gap-2">
        <UCheckbox
          :model-value="true"
          disabled
          size="lg"
          :label="t('settings.infrastructure.handler.connectionEstablished')"
          :ui="{ label: 'text-[13px] font-semibold text-emerald-300' }"
        />
        <div class="flex items-center gap-1">
          <UButton
            icon="i-lucide-pencil"
            color="neutral"
            variant="ghost"
            size="xs"
            :disabled="busy"
            :aria-label="t('common.edit')"
            @click="editing = true"
          />
          <UButton
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            size="xs"
            :disabled="busy"
            :aria-label="t('settings.infrastructure.handler.disconnect')"
            @click="remove"
          />
        </div>
      </div>
      <p class="pl-7 text-[11px] text-slate-300">
        {{ t('settings.infrastructure.cloudflare.connectedAs', { subdomain: workersSubdomain }) }}
      </p>
    </div>

    <div v-else class="space-y-2" data-testid="cloudflare-handler-form">
      <div class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('settings.infrastructure.cloudflare.label')
        }}</label>
        <UInput v-model="label" size="xs" />
      </div>

      <div class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('settings.infrastructure.cloudflare.subdomain')
        }}</label>
        <UInput v-model="workersSubdomain" size="xs" placeholder="my-account" />
        <p class="text-[11px] text-slate-500">
          {{ t('settings.infrastructure.cloudflare.subdomainHint') }}
        </p>
      </div>

      <div class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('settings.infrastructure.cloudflare.token')
        }}</label>
        <UInput
          v-model="token"
          type="password"
          size="xs"
          :placeholder="
            handler
              ? t('settings.infrastructure.cloudflare.tokenKeep')
              : t('settings.infrastructure.cloudflare.tokenPlaceholder')
          "
        />
        <p class="text-[11px] text-slate-500">
          {{ t('settings.infrastructure.cloudflare.tokenHint') }}
        </p>
      </div>

      <div class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('settings.infrastructure.cloudflare.repo')
        }}</label>
        <UInput v-model="repo" size="xs" placeholder="owner/repo" />
        <p class="text-[11px] text-slate-500">
          {{ t('settings.infrastructure.cloudflare.repoHint') }}
        </p>
      </div>

      <details class="rounded-md border border-slate-700/70 p-2">
        <summary class="cursor-pointer text-[11px] text-slate-400">
          {{ t('settings.infrastructure.cloudflare.advanced') }}
        </summary>
        <div class="mt-2 space-y-2">
          <div class="space-y-1">
            <label class="text-[11px] text-slate-400">{{
              t('settings.infrastructure.cloudflare.workerTemplate')
            }}</label>
            <!-- The placeholder is a FORMAT EXAMPLE containing vue-i18n metacharacters, so it
                 stays inline rather than becoming a catalog key. -->
            <UInput
              v-model="workerNameTemplate"
              size="xs"
              placeholder="cat-factory-pr-{{pullNumber}}"
            />
          </div>
          <div class="space-y-1">
            <label class="text-[11px] text-slate-400">{{
              t('settings.infrastructure.cloudflare.environmentTemplate')
            }}</label>
            <UInput v-model="environmentNameTemplate" size="xs" placeholder="pr-{{pullNumber}}" />
          </div>
          <p class="text-[11px] text-slate-500">
            {{ t('settings.infrastructure.cloudflare.templateHint') }}
          </p>
          <div class="space-y-1">
            <label class="text-[11px] text-slate-400">{{
              t('settings.infrastructure.cloudflare.apiBaseUrl')
            }}</label>
            <UInput v-model="apiBaseUrl" size="xs" placeholder="https://api.github.com" />
          </div>
        </div>
      </details>

      <div class="flex items-center gap-2">
        <UButton size="xs" :disabled="!canSave || busy" @click="save">
          {{ t('common.save') }}
        </UButton>
        <UButton
          size="xs"
          color="neutral"
          variant="subtle"
          :disabled="!canSave || testing"
          :loading="testing"
          @click="test"
        >
          {{ t('settings.providerConnection.test.button') }}
        </UButton>
        <UButton
          v-if="handler"
          size="xs"
          color="neutral"
          variant="ghost"
          :disabled="busy"
          @click="editing = false"
        >
          {{ t('common.cancel') }}
        </UButton>
      </div>

      <p
        v-if="testResult"
        class="text-[11px]"
        :class="testResult.ok ? 'text-emerald-300' : 'text-rose-300'"
      >
        {{ testResult.message }}
      </p>
    </div>
  </section>
</template>
