<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import type { ContentStorageBackend, ContentStorageConfig } from '~/types/accountSettings'
import SecretInput from '~/components/common/SecretInput.vue'

// Deployment integration secrets for an account (admin only): the Slack app OAuth
// credentials, the container web-search upstream keys, and the binary-artifact (screenshot)
// content-storage backend — all moved out of env into the per-account settings store, sealed
// at rest. Secrets are write-only: the panel only ever shows whether each integration is
// configured (the `summary`), never the values; blank inputs leave a configured secret
// unchanged. Hidden when the settings store isn't wired (no ENCRYPTION_KEY).
const props = defineProps<{ accountId: string }>()

const store = useAccountSettingsStore()
const ui = useUiStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { t } = useI18n()
const { confirmAction } = useConfirmAction()

// Deep-link anchor: the pipeline-start "configure storage" prompt opens this tab with the
// ui store's scroll target set to `content-storage`, so we bring the storage section (which
// sits at the bottom of a long tab) into view once rather than leaving the user to hunt for
// it. Scrolls after the section actually renders (it is gated on the async settings load).
const storageSection = ref<HTMLElement | null>(null)
async function maybeScrollToStorage() {
  if (ui.accountSettingsScrollTarget !== 'content-storage') return
  await nextTick()
  const el = storageSection.value
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  ui.clearAccountSettingsScrollTarget()
}
watch(
  () => ui.accountSettingsScrollTarget,
  () => {
    void maybeScrollToStorage()
  },
)

const slack = reactive({ clientId: '', clientSecret: '', redirectUrl: '' })
const linear = reactive({ clientId: '', clientSecret: '', redirectUrl: '' })
// The deployment's registered Figma app, which is what turns "Connect with Figma" on for every
// board in the account. Without it the Figma document source still connects, by personal access
// token — which is the step this exists to spare a designer.
const figma = reactive({ clientId: '', clientSecret: '', redirectUrl: '' })
const web = reactive({ braveApiKey: '', searxngUrl: '', searxngApiKey: '' })
const savingSlack = ref(false)
const savingLinear = ref(false)
const savingFigma = ref(false)
const savingWeb = ref(false)

const summary = computed(() => store.view?.summary ?? null)

// ---- Content storage (binary artifacts / screenshots) --------------------
// Exhaustive enum→key map (drift guard tier 2): every backend resolves to a static literal
// `t()` key, so adding a backend without a label fails the typecheck on this Record.
const contentBackendLabels = computed<Record<ContentStorageBackend, string>>(() => ({
  off: t('layout.accountDeployment.contentStorage.backends.off'),
  fs: t('layout.accountDeployment.contentStorage.backends.fs'),
  s3: t('layout.accountDeployment.contentStorage.backends.s3'),
  r2: t('layout.accountDeployment.contentStorage.backends.r2'),
  db: t('layout.accountDeployment.contentStorage.backends.db'),
  custom: t('layout.accountDeployment.contentStorage.backends.custom'),
}))
const storageCapability = computed(() => store.view?.contentStorageCapability ?? null)
const storageSummary = computed(() => summary.value?.contentStorage ?? null)
// A deployment-registered store is selected as `custom` PLUS an id, so one select carries both:
// each registered store is its own option, tagged so the save path can tell it from a built-in
// backend. A two-control version (backend, then store) would leave "custom" selectable with no
// store chosen, which is the one content-storage config that means nothing.
const CUSTOM_OPTION_PREFIX = 'custom:'
const customStores = computed(() => storageCapability.value?.customStores ?? [])
/**
 * The store an account is configured with that this deployment does NOT register: its build no
 * longer carries it, or it never did. Kept as its own selectable option rather than dropped, so
 * the control shows what is actually stored; hiding it would render an empty select over a
 * working-looking account whose artifacts are going nowhere.
 */
const unregisteredStoreId = computed(() => {
  const configured = store.view?.config?.contentStorage
  if (configured?.backend !== 'custom') return null
  const id = configured.custom?.storeId
  if (!id || customStores.value.some((s) => s.id === id)) return null
  return id
})
const backendItems = computed(() => [
  ...(storageCapability.value?.supportedBackends ?? []).flatMap((b) =>
    b === 'custom'
      ? customStores.value.map((s) => ({
          label: s.name,
          value: `${CUSTOM_OPTION_PREFIX}${s.id}`,
        }))
      : [{ label: contentBackendLabels.value[b], value: b as string }],
  ),
  ...(unregisteredStoreId.value
    ? [
        {
          label: t('layout.accountDeployment.contentStorage.unregisteredStore', {
            store: unregisteredStoreId.value,
          }),
          value: `${CUSTOM_OPTION_PREFIX}${unregisteredStoreId.value}`,
        },
      ]
    : []),
])
/** The select's value: a backend id, or `custom:<storeId>` for a registered store. */
const csBackend = ref<string>('off')
/** The registered store the select currently names, for the note under it. */
const selectedCustomStore = computed(() =>
  customStores.value.find((s) => `${CUSTOM_OPTION_PREFIX}${s.id}` === csBackend.value),
)
/**
 * What the status badge says. `custom` is the one backend whose own label names nothing an
 * operator can act on, so it resolves to the STORE: its registered name, or the bare id when this
 * build does not register it (which the warning below then explains).
 */
const configuredStorageLabel = computed(() => {
  const configured = storageSummary.value
  if (!configured?.backend) return null
  if (configured.backend !== 'custom') return contentBackendLabels.value[configured.backend]
  const registered = customStores.value.find((s) => s.id === configured.customStoreId)
  return registered?.name ?? configured.customStoreId ?? contentBackendLabels.value.custom
})
const cs = reactive({
  basePath: '',
  region: '',
  bucket: '',
  prefix: '',
  endpoint: '',
  forcePathStyle: false,
  accessKeyId: '',
  secretAccessKey: '',
})
const savingStorage = ref(false)

function hydrateStorage() {
  const cfg = store.view?.config?.contentStorage
  csBackend.value =
    cfg?.backend === 'custom' && cfg.custom?.storeId
      ? `${CUSTOM_OPTION_PREFIX}${cfg.custom.storeId}`
      : (cfg?.backend ?? storageCapability.value?.defaultBackend ?? 'off')
  cs.basePath = cfg?.fs?.basePath ?? ''
  cs.region = cfg?.s3?.region ?? ''
  cs.bucket = cfg?.s3?.bucket ?? ''
  cs.prefix = cfg?.s3?.prefix ?? ''
  cs.endpoint = cfg?.s3?.endpoint ?? ''
  cs.forcePathStyle = cfg?.s3?.forcePathStyle ?? false
  cs.accessKeyId = ''
  cs.secretAccessKey = ''
}

onMounted(async () => {
  try {
    await store.load(props.accountId)
    hydrateStorage()
    // The storage section only renders once the settings load resolves, so attempt the
    // deep-link scroll here (the up-front watcher misses the target set before mount).
    void maybeScrollToStorage()
  } catch (e) {
    present(e, 'layout.accountDeployment.loadFailed')
  }
})

async function saveStorage() {
  const selected = csBackend.value
  const customStoreId = selected.startsWith(CUSTOM_OPTION_PREFIX)
    ? selected.slice(CUSTOM_OPTION_PREFIX.length)
    : null
  const backend: ContentStorageBackend = customStoreId
    ? 'custom'
    : (selected as ContentStorageBackend)
  const config: ContentStorageConfig = customStoreId
    ? { backend, custom: { storeId: customStoreId } }
    : { backend }
  if (backend === 'fs' && cs.basePath.trim()) {
    config.fs = { basePath: cs.basePath.trim() }
  }
  if (backend === 's3') {
    if (!cs.region.trim() || !cs.bucket.trim()) {
      toast.add({
        title: t('layout.accountDeployment.contentStorage.regionBucketValidation'),
        color: 'error',
      })
      return
    }
    config.s3 = {
      region: cs.region.trim(),
      bucket: cs.bucket.trim(),
      ...(cs.prefix.trim() ? { prefix: cs.prefix.trim() } : {}),
      ...(cs.endpoint.trim() ? { endpoint: cs.endpoint.trim() } : {}),
      ...(cs.forcePathStyle ? { forcePathStyle: true } : {}),
    }
  }
  // `config` fully REPLACES the stored non-secret config, so carry the rest forward
  // (e.g. the model-family policy) — only `contentStorage` is edited here.
  const input: Parameters<typeof store.save>[1] = {
    config: { ...store.view?.config, contentStorage: config },
  }
  if (backend === 's3') {
    const id = cs.accessKeyId.trim()
    const key = cs.secretAccessKey.trim()
    if (id && key) {
      input.secrets = { s3: { accessKeyId: id, secretAccessKey: key } }
    } else if (id || key) {
      toast.add({
        title: t('layout.accountDeployment.contentStorage.bothKeysValidation'),
        color: 'error',
      })
      return
    } else if (!storageSummary.value?.s3CredentialsConfigured) {
      toast.add({
        title: t('layout.accountDeployment.contentStorage.keysValidation'),
        color: 'error',
      })
      return
    }
    // else: keys already stored and none re-entered → leave them unchanged.
  } else {
    // Switching off S3: drop any stored S3 credentials.
    input.secrets = { s3: null }
  }
  savingStorage.value = true
  try {
    await store.save(props.accountId, input)
    hydrateStorage()
    toast.add({
      title: t('layout.accountDeployment.contentStorage.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'layout.accountDeployment.contentStorage.saveFailed')
  } finally {
    savingStorage.value = false
  }
}

async function saveSlack() {
  if (!slack.clientId.trim() || !slack.clientSecret.trim() || !slack.redirectUrl.trim()) {
    toast.add({ title: t('layout.accountDeployment.slack.validation'), color: 'error' })
    return
  }
  savingSlack.value = true
  try {
    await store.save(props.accountId, {
      secrets: {
        slackOAuth: {
          clientId: slack.clientId.trim(),
          clientSecret: slack.clientSecret.trim(),
          redirectUrl: slack.redirectUrl.trim(),
        },
      },
    })
    slack.clientId = ''
    slack.clientSecret = ''
    slack.redirectUrl = ''
    toast.add({
      title: t('layout.accountDeployment.slack.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'layout.accountDeployment.slack.saveFailed')
  } finally {
    savingSlack.value = false
  }
}

async function clearSlack() {
  if (!(await confirmAction('clear', 'Slack'))) return
  savingSlack.value = true
  try {
    await store.save(props.accountId, { secrets: { slackOAuth: null } })
    toast.add({
      title: t('layout.accountDeployment.slack.cleared'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'layout.accountDeployment.slack.clearFailed')
  } finally {
    savingSlack.value = false
  }
}

async function saveLinear() {
  if (!linear.clientId.trim() || !linear.clientSecret.trim() || !linear.redirectUrl.trim()) {
    toast.add({ title: t('layout.accountDeployment.linear.validation'), color: 'error' })
    return
  }
  savingLinear.value = true
  try {
    await store.save(props.accountId, {
      secrets: {
        linearOAuth: {
          clientId: linear.clientId.trim(),
          clientSecret: linear.clientSecret.trim(),
          redirectUrl: linear.redirectUrl.trim(),
        },
      },
    })
    linear.clientId = ''
    linear.clientSecret = ''
    linear.redirectUrl = ''
    toast.add({
      title: t('layout.accountDeployment.linear.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'layout.accountDeployment.linear.saveFailed')
  } finally {
    savingLinear.value = false
  }
}

async function clearLinear() {
  if (!(await confirmAction('clear', 'Linear'))) return
  savingLinear.value = true
  try {
    await store.save(props.accountId, { secrets: { linearOAuth: null } })
    toast.add({
      title: t('layout.accountDeployment.linear.cleared'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'layout.accountDeployment.linear.clearFailed')
  } finally {
    savingLinear.value = false
  }
}

async function saveFigma() {
  if (!figma.clientId.trim() || !figma.clientSecret.trim() || !figma.redirectUrl.trim()) {
    toast.add({ title: t('layout.accountDeployment.figma.validation'), color: 'error' })
    return
  }
  savingFigma.value = true
  try {
    await store.save(props.accountId, {
      secrets: {
        figmaOAuth: {
          clientId: figma.clientId.trim(),
          clientSecret: figma.clientSecret.trim(),
          redirectUrl: figma.redirectUrl.trim(),
        },
      },
    })
    figma.clientId = ''
    figma.clientSecret = ''
    figma.redirectUrl = ''
    toast.add({
      title: t('layout.accountDeployment.figma.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'layout.accountDeployment.figma.saveFailed')
  } finally {
    savingFigma.value = false
  }
}

async function clearFigma() {
  if (!(await confirmAction('clear', 'Figma'))) return
  savingFigma.value = true
  try {
    await store.save(props.accountId, { secrets: { figmaOAuth: null } })
    toast.add({
      title: t('layout.accountDeployment.figma.cleared'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'layout.accountDeployment.figma.clearFailed')
  } finally {
    savingFigma.value = false
  }
}

async function saveWeb() {
  const brave = web.braveApiKey.trim()
  const searxng = web.searxngUrl.trim()
  if (!brave && !searxng) {
    toast.add({ title: t('layout.accountDeployment.web.validation'), color: 'error' })
    return
  }
  savingWeb.value = true
  try {
    await store.save(props.accountId, {
      secrets: {
        webSearch: {
          ...(brave ? { braveApiKey: brave } : {}),
          ...(searxng ? { searxngUrl: searxng } : {}),
          ...(web.searxngApiKey.trim() ? { searxngApiKey: web.searxngApiKey.trim() } : {}),
        },
      },
    })
    web.braveApiKey = ''
    web.searxngUrl = ''
    web.searxngApiKey = ''
    toast.add({
      title: t('layout.accountDeployment.web.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'layout.accountDeployment.web.saveFailed')
  } finally {
    savingWeb.value = false
  }
}

async function clearWeb() {
  if (!(await confirmAction('clear', t('layout.accountDeployment.web.title')))) return
  savingWeb.value = true
  try {
    await store.save(props.accountId, { secrets: { webSearch: null } })
    toast.add({
      title: t('layout.accountDeployment.web.cleared'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'layout.accountDeployment.web.clearFailed')
  } finally {
    savingWeb.value = false
  }
}
</script>

<template>
  <div v-if="store.available !== false" class="space-y-6">
    <div>
      <h3 class="mb-1 font-semibold text-white">{{ t('layout.accountDeployment.title') }}</h3>
      <p class="text-[11px] text-slate-400">
        {{ t('layout.accountDeployment.intro') }}
      </p>
    </div>

    <!-- Slack app OAuth -->
    <section class="space-y-2">
      <div class="flex items-center gap-2">
        <h4 class="text-sm font-semibold text-slate-200">
          {{ t('layout.accountDeployment.slack.title') }}
        </h4>
        <UBadge
          :color="summary?.slackOAuthConfigured ? 'success' : 'neutral'"
          variant="subtle"
          size="xs"
        >
          {{
            summary?.slackOAuthConfigured
              ? t('layout.accountDeployment.configured')
              : t('layout.accountDeployment.notSet')
          }}
        </UBadge>
      </div>
      <p class="text-[11px] text-slate-400">
        {{ t('layout.accountDeployment.slack.description') }}
      </p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <UInput
          v-model="slack.clientId"
          :placeholder="t('layout.accountDeployment.slack.clientId')"
          size="sm"
        />
        <SecretInput
          v-model="slack.clientSecret"
          :placeholder="t('layout.accountDeployment.slack.clientSecret')"
          size="sm"
        />
        <UInput
          v-model="slack.redirectUrl"
          :placeholder="t('layout.accountDeployment.slack.redirectUrl')"
          size="sm"
        />
      </div>
      <div class="flex gap-2">
        <UButton
          color="primary"
          size="xs"
          icon="i-lucide-save"
          :loading="savingSlack"
          @click="saveSlack"
        >
          {{ t('common.save') }}
        </UButton>
        <UButton
          v-if="summary?.slackOAuthConfigured"
          color="neutral"
          variant="ghost"
          size="xs"
          :loading="savingSlack"
          @click="clearSlack"
        >
          {{ t('layout.accountDeployment.clear') }}
        </UButton>
      </div>
    </section>

    <!-- Linear app OAuth -->
    <section class="space-y-2 border-t border-slate-800 pt-6">
      <div class="flex items-center gap-2">
        <h4 class="text-sm font-semibold text-slate-200">
          {{ t('layout.accountDeployment.linear.title') }}
        </h4>
        <UBadge
          :color="summary?.linearOAuthConfigured ? 'success' : 'neutral'"
          variant="subtle"
          size="xs"
        >
          {{
            summary?.linearOAuthConfigured
              ? t('layout.accountDeployment.configured')
              : t('layout.accountDeployment.notSet')
          }}
        </UBadge>
      </div>
      <p class="text-[11px] text-slate-400">
        {{ t('layout.accountDeployment.linear.description') }}
      </p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <UInput
          v-model="linear.clientId"
          :placeholder="t('layout.accountDeployment.linear.clientId')"
          size="sm"
        />
        <SecretInput
          v-model="linear.clientSecret"
          :placeholder="t('layout.accountDeployment.linear.clientSecret')"
          size="sm"
        />
        <UInput
          v-model="linear.redirectUrl"
          :placeholder="t('layout.accountDeployment.linear.redirectUrl')"
          size="sm"
        />
      </div>
      <div class="flex gap-2">
        <UButton
          color="primary"
          size="xs"
          icon="i-lucide-save"
          :loading="savingLinear"
          @click="saveLinear"
        >
          {{ t('common.save') }}
        </UButton>
        <UButton
          v-if="summary?.linearOAuthConfigured"
          color="neutral"
          variant="ghost"
          size="xs"
          :loading="savingLinear"
          @click="clearLinear"
        >
          {{ t('layout.accountDeployment.clear') }}
        </UButton>
      </div>
    </section>

    <!-- Figma app OAuth (the document source's designer-doable connect) -->
    <section class="space-y-2 border-t border-slate-800 pt-6">
      <div class="flex items-center gap-2">
        <h4 class="text-sm font-semibold text-slate-200">
          {{ t('layout.accountDeployment.figma.title') }}
        </h4>
        <UBadge
          :color="summary?.figmaOAuthConfigured ? 'success' : 'neutral'"
          variant="subtle"
          size="xs"
        >
          {{
            summary?.figmaOAuthConfigured
              ? t('layout.accountDeployment.configured')
              : t('layout.accountDeployment.notSet')
          }}
        </UBadge>
      </div>
      <p class="text-[11px] text-slate-400">
        {{ t('layout.accountDeployment.figma.description') }}
      </p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <UInput
          v-model="figma.clientId"
          :placeholder="t('layout.accountDeployment.figma.clientId')"
          size="sm"
        />
        <SecretInput
          v-model="figma.clientSecret"
          :placeholder="t('layout.accountDeployment.figma.clientSecret')"
          size="sm"
        />
        <UInput
          v-model="figma.redirectUrl"
          :placeholder="t('layout.accountDeployment.figma.redirectUrl')"
          size="sm"
        />
      </div>
      <div class="flex gap-2">
        <UButton
          color="primary"
          size="xs"
          icon="i-lucide-save"
          :loading="savingFigma"
          @click="saveFigma"
        >
          {{ t('common.save') }}
        </UButton>
        <UButton
          v-if="summary?.figmaOAuthConfigured"
          color="neutral"
          variant="ghost"
          size="xs"
          :loading="savingFigma"
          @click="clearFigma"
        >
          {{ t('layout.accountDeployment.clear') }}
        </UButton>
      </div>
    </section>

    <!-- Web search keys -->
    <section class="space-y-2 border-t border-slate-800 pt-6">
      <div class="flex items-center gap-2">
        <h4 class="text-sm font-semibold text-slate-200">
          {{ t('layout.accountDeployment.web.title') }}
        </h4>
        <UBadge :color="summary?.webSearch ? 'success' : 'neutral'" variant="subtle" size="xs">
          {{
            summary?.webSearch
              ? t('layout.accountDeployment.web.configured', { provider: summary.webSearch })
              : t('layout.accountDeployment.notSet')
          }}
        </UBadge>
      </div>
      <p class="text-[11px] text-slate-400">
        {{ t('layout.accountDeployment.web.description') }}
      </p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <SecretInput
          v-model="web.braveApiKey"
          :placeholder="t('layout.accountDeployment.web.braveKey')"
          size="sm"
        />
        <UInput
          v-model="web.searxngUrl"
          :placeholder="t('layout.accountDeployment.web.searxngUrl')"
          size="sm"
        />
        <SecretInput
          v-model="web.searxngApiKey"
          :placeholder="t('layout.accountDeployment.web.searxngKey')"
          size="sm"
        />
      </div>
      <div class="flex gap-2">
        <UButton
          color="primary"
          size="xs"
          icon="i-lucide-save"
          :loading="savingWeb"
          @click="saveWeb"
        >
          {{ t('common.save') }}
        </UButton>
        <UButton
          v-if="summary?.webSearch"
          color="neutral"
          variant="ghost"
          size="xs"
          :loading="savingWeb"
          @click="clearWeb"
        >
          {{ t('layout.accountDeployment.clear') }}
        </UButton>
      </div>
    </section>

    <!-- Content storage (binary artifacts / screenshots) -->
    <section
      v-if="storageCapability"
      id="content-storage"
      ref="storageSection"
      class="space-y-2 border-t border-slate-800 pt-6"
    >
      <div class="flex items-center gap-2">
        <h4 class="text-sm font-semibold text-slate-200">
          {{ t('layout.accountDeployment.contentStorage.title') }}
        </h4>
        <UBadge
          :color="
            storageSummary?.backend && storageSummary.backend !== 'off' ? 'success' : 'neutral'
          "
          variant="subtle"
          size="xs"
        >
          {{
            configuredStorageLabel ??
            t('layout.accountDeployment.contentStorage.default', {
              backend: contentBackendLabels[storageCapability.defaultBackend],
            })
          }}
        </UBadge>
      </div>
      <p class="text-[11px] text-slate-400">
        {{ t('layout.accountDeployment.contentStorage.description') }}
      </p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <USelect v-model="csBackend" :items="backendItems" value-key="value" size="sm" />
      </div>
      <p v-if="selectedCustomStore?.summary" class="text-[11px] text-slate-400">
        {{ selectedCustomStore.summary }}
      </p>
      <p v-if="unregisteredStoreId" class="text-[11px] text-amber-400">
        {{
          t('layout.accountDeployment.contentStorage.unregisteredStoreWarning', {
            store: unregisteredStoreId,
          })
        }}
      </p>

      <!-- Filesystem -->
      <div v-if="csBackend === 'fs'" class="grid grid-cols-1 gap-2">
        <UInput
          v-model="cs.basePath"
          :placeholder="t('layout.accountDeployment.contentStorage.basePath')"
          size="sm"
        />
      </div>

      <!-- S3 / S3-compatible -->
      <template v-if="csBackend === 's3'">
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <UInput
            v-model="cs.region"
            :placeholder="t('layout.accountDeployment.contentStorage.region')"
            size="sm"
          />
          <UInput
            v-model="cs.bucket"
            :placeholder="t('layout.accountDeployment.contentStorage.bucket')"
            size="sm"
          />
          <UInput
            v-model="cs.prefix"
            :placeholder="t('layout.accountDeployment.contentStorage.prefix')"
            size="sm"
          />
          <UInput
            v-model="cs.endpoint"
            :placeholder="t('layout.accountDeployment.contentStorage.endpoint')"
            size="sm"
          />
        </div>
        <UCheckbox
          v-model="cs.forcePathStyle"
          :label="t('layout.accountDeployment.contentStorage.forcePathStyle')"
          size="sm"
        />
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-slate-400">
            {{ t('layout.accountDeployment.contentStorage.accessKeys') }}
          </span>
          <UBadge
            :color="storageSummary?.s3CredentialsConfigured ? 'success' : 'neutral'"
            variant="subtle"
            size="xs"
          >
            {{
              storageSummary?.s3CredentialsConfigured
                ? t('layout.accountDeployment.configured')
                : t('layout.accountDeployment.notSet')
            }}
          </UBadge>
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <SecretInput
            v-model="cs.accessKeyId"
            :placeholder="t('layout.accountDeployment.contentStorage.accessKeyId')"
            size="sm"
          />
          <SecretInput
            v-model="cs.secretAccessKey"
            :placeholder="t('layout.accountDeployment.contentStorage.secretAccessKey')"
            size="sm"
          />
        </div>
        <p class="text-[11px] text-slate-400">
          {{ t('layout.accountDeployment.contentStorage.keysHint') }}
        </p>
      </template>

      <div class="flex gap-2">
        <UButton
          color="primary"
          size="xs"
          icon="i-lucide-save"
          :loading="savingStorage"
          @click="saveStorage"
        >
          {{ t('common.save') }}
        </UButton>
      </div>
    </section>
  </div>
</template>
