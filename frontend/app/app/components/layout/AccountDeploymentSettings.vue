<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { ContentStorageBackend, ContentStorageConfig } from '~/types/accountSettings'

// Deployment integration secrets for an account (admin only): the Slack app OAuth
// credentials, the container web-search upstream keys, and the binary-artifact (screenshot)
// content-storage backend — all moved out of env into the per-account settings store, sealed
// at rest. Secrets are write-only: the panel only ever shows whether each integration is
// configured (the `summary`), never the values; blank inputs leave a configured secret
// unchanged. Hidden when the settings store isn't wired (no ENCRYPTION_KEY).
const props = defineProps<{ accountId: string }>()

const store = useAccountSettingsStore()
const toast = useToast()
const { t } = useI18n()

const slack = reactive({ clientId: '', clientSecret: '', redirectUrl: '' })
const web = reactive({ braveApiKey: '', searxngUrl: '', searxngApiKey: '' })
const savingSlack = ref(false)
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
}))
const storageCapability = computed(() => store.view?.contentStorageCapability ?? null)
const storageSummary = computed(() => summary.value?.contentStorage ?? null)
const backendItems = computed(() =>
  (storageCapability.value?.supportedBackends ?? []).map((b) => ({
    label: contentBackendLabels.value[b],
    value: b,
  })),
)
const csBackend = ref<ContentStorageBackend>('off')
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
  csBackend.value = cfg?.backend ?? storageCapability.value?.defaultBackend ?? 'off'
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
  } catch (e) {
    toast.add({
      title: t('layout.accountDeployment.loadFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
})

async function saveStorage() {
  const backend = csBackend.value
  const config: ContentStorageConfig = { backend }
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
  const input: Parameters<typeof store.save>[1] = { config: { contentStorage: config } }
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
    toast.add({
      title: t('layout.accountDeployment.contentStorage.saveFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
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
    toast.add({
      title: t('layout.accountDeployment.slack.saveFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    savingSlack.value = false
  }
}

async function clearSlack() {
  savingSlack.value = true
  try {
    await store.save(props.accountId, { secrets: { slackOAuth: null } })
    toast.add({
      title: t('layout.accountDeployment.slack.cleared'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('layout.accountDeployment.slack.clearFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    savingSlack.value = false
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
    toast.add({
      title: t('layout.accountDeployment.web.saveFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    savingWeb.value = false
  }
}

async function clearWeb() {
  savingWeb.value = true
  try {
    await store.save(props.accountId, { secrets: { webSearch: null } })
    toast.add({
      title: t('layout.accountDeployment.web.cleared'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('layout.accountDeployment.web.clearFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
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
        <UInput
          v-model="slack.clientSecret"
          type="password"
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
        <UInput
          v-model="web.braveApiKey"
          type="password"
          :placeholder="t('layout.accountDeployment.web.braveKey')"
          size="sm"
        />
        <UInput
          v-model="web.searxngUrl"
          :placeholder="t('layout.accountDeployment.web.searxngUrl')"
          size="sm"
        />
        <UInput
          v-model="web.searxngApiKey"
          type="password"
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
    <section v-if="storageCapability" class="space-y-2 border-t border-slate-800 pt-6">
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
            storageSummary?.backend
              ? contentBackendLabels[storageSummary.backend]
              : t('layout.accountDeployment.contentStorage.default', {
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
          <UInput
            v-model="cs.accessKeyId"
            type="password"
            :placeholder="t('layout.accountDeployment.contentStorage.accessKeyId')"
            size="sm"
          />
          <UInput
            v-model="cs.secretAccessKey"
            type="password"
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
