<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

// Deployment integration secrets for an account (admin only): the Slack app OAuth
// credentials and the container web-search upstream keys — both moved out of env into
// the per-account settings store, sealed at rest. Secrets are write-only: the panel only
// ever shows whether each integration is configured (the `summary`), never the values;
// blank inputs leave a configured secret unchanged. Hidden when the settings store isn't
// wired (no ENCRYPTION_KEY).
const props = defineProps<{ accountId: string }>()

const store = useAccountSettingsStore()
const toast = useToast()
const { t } = useI18n()

const slack = reactive({ clientId: '', clientSecret: '', redirectUrl: '' })
const web = reactive({ braveApiKey: '', searxngUrl: '', searxngApiKey: '' })
const savingSlack = ref(false)
const savingWeb = ref(false)

const summary = computed(() => store.view?.summary ?? null)

onMounted(async () => {
  try {
    await store.load(props.accountId)
  } catch (e) {
    toast.add({
      title: t('layout.accountDeployment.loadFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
})

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
  </div>
</template>
