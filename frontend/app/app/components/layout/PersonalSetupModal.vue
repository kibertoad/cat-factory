<script setup lang="ts">
// "My setup": the user-scoped sibling of the Integrations hub. It lists the connections
// that belong to the SIGNED-IN USER rather than the workspace — a personal GitHub token,
// own-machine local model runners, and individual-usage (personal) subscriptions — which
// previously sat, confusingly, among the workspace-wide integrations. Each row reuses the
// existing per-panel handlers via `ui.openFromPersonal(...)`, so opening one closes this
// hub, reveals that panel, and gives it a "Back to My setup" control (IntegrationBackTitle).
import SectionLabel from '~/components/common/SectionLabel.vue'
import AppModal from '~/components/common/AppModal.vue'
import { connectionRowState, type ConnectionRowState } from '~/utils/connectionRowState'

const { t } = useI18n()
const ui = useUiStore()
const userSecrets = useUserSecretsStore()
const localModels = useLocalModelsStore()
const personalSubs = usePersonalSubscriptionsStore()

// Load the cheap user-scoped status as the hub opens, so each row's badge is accurate. The
// board mounts this modal only while `personalSetupOpen` is true and unmounts it on close, so
// setup runs once per open. Each `load()` settles on its own and records a failure in its
// store's `loadFailed`, which the row reads.
void userSecrets.load()
void localModels.load()
void personalSubs.load()

const open = computed({
  get: () => ui.personalSetupOpen,
  set: (v: boolean) => (v ? ui.openPersonalSetup() : ui.closePersonalSetup()),
})

// One row. `state` drives the badge (`connectionRowState`); `status` is the connected-state
// line (a count or "Connected"). Mirrors the Integrations hub's row shape so the two hubs look
// identical.
interface PersonalItem {
  key: string
  icon: string
  label: string
  description: string
  status?: string
  state: ConnectionRowState
  onClick: () => void
}

interface PersonalGroup {
  title: string
  items: PersonalItem[]
}

// Open a user-scoped panel from this hub (sets the "came from My setup" marker).
function go(fn: () => void) {
  ui.openFromPersonal(fn)
}

const groups = computed<PersonalGroup[]>(() => {
  const out: PersonalGroup[] = []

  // --- Source control --------------------------------------------------------
  const pat = !!userSecrets.statusFor('github_pat')
  out.push({
    title: t('layout.personalSetup.sourceControl.title'),
    items: [
      {
        key: 'github-pat',
        icon: 'i-lucide-key-round',
        label: t('layout.personalSetup.githubToken.label'),
        description: t('layout.personalSetup.githubToken.description'),
        status: pat ? t('layout.personalSetup.connected') : undefined,
        state: connectionRowState(pat, userSecrets),
        onClick: () => go(ui.openUserSecrets),
      },
    ],
  })

  // --- Models ----------------------------------------------------------------
  const runnerCount = localModels.endpoints.length
  const subCount = personalSubs.subscriptions.length
  out.push({
    title: t('layout.personalSetup.models.title'),
    items: [
      {
        key: 'local-runners',
        icon: 'i-lucide-server',
        label: t('layout.personalSetup.localRunners.label'),
        description: t('layout.personalSetup.localRunners.description'),
        status: runnerCount
          ? t('layout.personalSetup.connectedCount', { count: runnerCount }, runnerCount)
          : undefined,
        state: connectionRowState(runnerCount > 0, localModels),
        onClick: () => go(ui.openLocalModels),
      },
      {
        key: 'personal-subs',
        icon: 'i-lucide-user',
        label: t('layout.personalSetup.subscriptions.label'),
        description: t('layout.personalSetup.subscriptions.description'),
        status: subCount
          ? t('layout.personalSetup.connectedCount', { count: subCount }, subCount)
          : undefined,
        state: connectionRowState(subCount > 0, personalSubs),
        onClick: () => go(() => ui.openVendorCredentials('personal')),
      },
    ],
  })

  return out
})
</script>

<template>
  <AppModal size="form" v-model:open="open" :title="t('layout.personalSetup.title')">
    <template #body>
      <div class="space-y-5">
        <p class="text-xs text-muted">
          {{ t('layout.personalSetup.intro') }}
        </p>

        <section v-for="group in groups" :key="group.title">
          <SectionLabel as="h3" class="mb-2 px-1">
            {{ group.title }}
          </SectionLabel>
          <div class="space-y-1.5">
            <UButton
              color="neutral"
              variant="ghost"
              v-for="item in group.items"
              :key="item.key"
              class="flex w-full items-center gap-3 rounded-lg border border-default bg-default/50 px-3 py-2.5 text-start transition hover:border-muted hover:bg-default"
              @click="item.onClick()"
            >
              <UIcon :name="item.icon" class="h-5 w-5 shrink-0 text-toned" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate text-sm font-medium text-app-100">{{ item.label }}</span>
                  <UBadge
                    v-if="item.state === 'connected'"
                    color="success"
                    variant="subtle"
                    size="sm"
                    :data-testid="`personal-setup-connected-${item.key}`"
                  >
                    {{ item.status || t('layout.personalSetup.connected') }}
                  </UBadge>
                  <span v-else-if="item.state === 'checking'" class="text-2xs text-dimmed">
                    {{ t('common.checking') }}
                  </span>
                  <UBadge
                    v-else-if="item.state === 'failed'"
                    color="error"
                    variant="subtle"
                    size="sm"
                    :data-testid="`personal-setup-failed-${item.key}`"
                  >
                    {{ t('common.loadFailed') }}
                  </UBadge>
                  <span v-else class="text-2xs text-dimmed">
                    {{ t('layout.personalSetup.notConnected') }}
                  </span>
                </div>
                <p class="truncate text-xs text-muted">{{ item.description }}</p>
              </div>
              <UIcon
                name="i-lucide-chevron-right"
                class="h-4 w-4 shrink-0 text-dimmed rtl:-scale-x-100"
              />
            </UButton>
          </div>
        </section>
      </div>
    </template>
  </AppModal>
</template>
