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

const slack = reactive({ clientId: '', clientSecret: '', redirectUrl: '' })
const web = reactive({ braveApiKey: '', searxngUrl: '', searxngApiKey: '' })
const savingSlack = ref(false)
const savingWeb = ref(false)

const summary = computed(() => store.view?.summary ?? null)

// ---- Content storage (binary artifacts / screenshots) --------------------
const CONTENT_BACKEND_LABELS: Record<ContentStorageBackend, string> = {
  off: 'Off (storage disabled)',
  fs: 'Local filesystem',
  s3: 'Amazon S3 / S3-compatible',
  r2: 'Cloudflare R2',
  db: 'Postgres database',
}
const storageCapability = computed(() => store.view?.contentStorageCapability ?? null)
const storageSummary = computed(() => summary.value?.contentStorage ?? null)
const backendItems = computed(() =>
  (storageCapability.value?.supportedBackends ?? []).map((b) => ({
    label: CONTENT_BACKEND_LABELS[b],
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
      title: 'Could not load deployment settings',
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
      toast.add({ title: 'Enter the S3 region and bucket', color: 'error' })
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
      toast.add({ title: 'Enter both the access key id and secret', color: 'error' })
      return
    } else if (!storageSummary.value?.s3CredentialsConfigured) {
      toast.add({ title: 'Enter the S3 access key id and secret', color: 'error' })
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
    toast.add({ title: 'Content storage saved', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not save content storage',
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    savingStorage.value = false
  }
}

async function saveSlack() {
  if (!slack.clientId.trim() || !slack.clientSecret.trim() || !slack.redirectUrl.trim()) {
    toast.add({ title: 'Enter the client id, secret and redirect URL', color: 'error' })
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
    toast.add({ title: 'Slack OAuth saved', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not save Slack OAuth',
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
    toast.add({ title: 'Slack OAuth cleared', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not clear Slack OAuth',
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
    toast.add({ title: 'Enter a Brave key or a SearXNG URL', color: 'error' })
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
    toast.add({ title: 'Web search keys saved', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not save web search keys',
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
    toast.add({ title: 'Web search keys cleared', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not clear web search keys',
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
      <h3 class="mb-1 font-semibold text-white">Deployment integrations</h3>
      <p class="text-[11px] text-slate-400">
        Credentials shared by every workspace in this account, sealed at rest. Values are never
        shown after saving; leave a field blank to keep the stored secret.
      </p>
    </div>

    <!-- Slack app OAuth -->
    <section class="space-y-2">
      <div class="flex items-center gap-2">
        <h4 class="text-sm font-semibold text-slate-200">Slack app (OAuth)</h4>
        <UBadge
          :color="summary?.slackOAuthConfigured ? 'success' : 'neutral'"
          variant="subtle"
          size="xs"
        >
          {{ summary?.slackOAuthConfigured ? 'Configured' : 'Not set' }}
        </UBadge>
      </div>
      <p class="text-[11px] text-slate-400">
        Enables the "Add to Slack" OAuth flow. Without it, workspaces can still connect Slack by
        pasting a bot token.
      </p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <UInput v-model="slack.clientId" placeholder="Client ID" size="sm" />
        <UInput
          v-model="slack.clientSecret"
          type="password"
          placeholder="Client secret"
          size="sm"
        />
        <UInput v-model="slack.redirectUrl" placeholder="Redirect URL" size="sm" />
      </div>
      <div class="flex gap-2">
        <UButton
          color="primary"
          size="xs"
          icon="i-lucide-save"
          :loading="savingSlack"
          @click="saveSlack"
        >
          Save
        </UButton>
        <UButton
          v-if="summary?.slackOAuthConfigured"
          color="neutral"
          variant="ghost"
          size="xs"
          :loading="savingSlack"
          @click="clearSlack"
        >
          Clear
        </UButton>
      </div>
    </section>

    <!-- Web search keys -->
    <section class="space-y-2 border-t border-slate-800 pt-6">
      <div class="flex items-center gap-2">
        <h4 class="text-sm font-semibold text-slate-200">Container web search</h4>
        <UBadge :color="summary?.webSearch ? 'success' : 'neutral'" variant="subtle" size="xs">
          {{ summary?.webSearch ? `Configured (${summary.webSearch})` : 'Not set' }}
        </UBadge>
      </div>
      <p class="text-[11px] text-slate-400">
        The search upstream container agents reach through the backend proxy. Set a Brave key
        (recommended), or a self-hosted SearXNG URL (with an optional bearer key).
      </p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <UInput v-model="web.braveApiKey" type="password" placeholder="Brave API key" size="sm" />
        <UInput v-model="web.searxngUrl" placeholder="SearXNG URL" size="sm" />
        <UInput
          v-model="web.searxngApiKey"
          type="password"
          placeholder="SearXNG key (optional)"
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
          Save
        </UButton>
        <UButton
          v-if="summary?.webSearch"
          color="neutral"
          variant="ghost"
          size="xs"
          :loading="savingWeb"
          @click="clearWeb"
        >
          Clear
        </UButton>
      </div>
    </section>

    <!-- Content storage (binary artifacts / screenshots) -->
    <section v-if="storageCapability" class="space-y-2 border-t border-slate-800 pt-6">
      <div class="flex items-center gap-2">
        <h4 class="text-sm font-semibold text-slate-200">Content storage</h4>
        <UBadge
          :color="
            storageSummary?.backend && storageSummary.backend !== 'off' ? 'success' : 'neutral'
          "
          variant="subtle"
          size="xs"
        >
          {{
            storageSummary?.backend
              ? CONTENT_BACKEND_LABELS[storageSummary.backend]
              : `Default (${CONTENT_BACKEND_LABELS[storageCapability.defaultBackend]})`
          }}
        </UBadge>
      </div>
      <p class="text-[11px] text-slate-400">
        Where UI-tester screenshots and reference design images for this account are stored. The
        metadata always lives in the database; only the file bytes go to the chosen backend.
      </p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <USelect v-model="csBackend" :items="backendItems" value-key="value" size="sm" />
      </div>

      <!-- Filesystem -->
      <div v-if="csBackend === 'fs'" class="grid grid-cols-1 gap-2">
        <UInput v-model="cs.basePath" placeholder="Base path (default: .file-storage)" size="sm" />
      </div>

      <!-- S3 / S3-compatible -->
      <template v-if="csBackend === 's3'">
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <UInput v-model="cs.region" placeholder="Region (e.g. us-east-1)" size="sm" />
          <UInput v-model="cs.bucket" placeholder="Bucket" size="sm" />
          <UInput v-model="cs.prefix" placeholder="Key prefix (optional)" size="sm" />
          <UInput
            v-model="cs.endpoint"
            placeholder="Endpoint (optional, S3-compatible)"
            size="sm"
          />
        </div>
        <UCheckbox
          v-model="cs.forcePathStyle"
          label="Force path-style addressing (most S3-compatible stores)"
          size="sm"
        />
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-slate-400">Access keys</span>
          <UBadge
            :color="storageSummary?.s3CredentialsConfigured ? 'success' : 'neutral'"
            variant="subtle"
            size="xs"
          >
            {{ storageSummary?.s3CredentialsConfigured ? 'Configured' : 'Not set' }}
          </UBadge>
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <UInput v-model="cs.accessKeyId" type="password" placeholder="Access key ID" size="sm" />
          <UInput
            v-model="cs.secretAccessKey"
            type="password"
            placeholder="Secret access key"
            size="sm"
          />
        </div>
        <p class="text-[11px] text-slate-400">
          Keys are sealed at rest and never shown after saving; leave blank to keep the stored keys.
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
          Save
        </UButton>
      </div>
    </section>
  </div>
</template>
