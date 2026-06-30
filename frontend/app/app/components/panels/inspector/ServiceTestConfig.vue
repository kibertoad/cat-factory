<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Block, CloudProvider, InstanceSize, ProvisionType } from '~/types/domain'
import RepoTreeBrowser from '~/components/github/RepoTreeBrowser.vue'

// Service-level (frame) configuration: the service-owned PROVISIONING — the provision
// TYPE this service produces (`infraless` / `docker-compose` / `kubernetes` / `custom`)
// plus, for docker-compose, the in-repo compose path the Tester stands up — and the
// cloud provider + instance size the service's container jobs run on. The WORKSPACE
// configures HOW each type is handled (the engine + connection), so this view only owns
// the "what + where". Autodiscovery suggests a compose path when the service is added.
const props = defineProps<{
  block: Block
  // Repo backing this service, supplied by the add-service modal when the block is
  // too fresh to be resolvable from the stores yet. Otherwise resolved below.
  repo?: { githubId: number; directory?: string | null }
}>()

const board = useBoardStore()
const accounts = useAccountsStore()
const github = useGitHubStore()
const services = useServicesStore()
const { t } = useI18n()

// The service's declared provision type (absent ⇒ treated as `infraless`: no environment
// is stood up for the Tester). Switching type preserves the compose path so toggling away
// and back doesn't lose it.
const provisionType = computed<ProvisionType>(() => props.block.provisioning?.type ?? 'infraless')
const composePath = computed(() => props.block.provisioning?.composePath ?? '')

const PROVISION_TYPES = computed<{ value: ProvisionType; label: string }[]>(() => [
  { value: 'infraless', label: t('inspector.testConfig.provisionTypes.infraless') },
  { value: 'docker-compose', label: t('inspector.testConfig.provisionTypes.docker-compose') },
  { value: 'kubernetes', label: t('inspector.testConfig.provisionTypes.kubernetes') },
  { value: 'custom', label: t('inspector.testConfig.provisionTypes.custom') },
])

function setProvisionType(type: ProvisionType) {
  // Carry the compose path across a switch so it isn't lost when toggling type.
  board.updateBlock(props.block.id, {
    provisioning: {
      type,
      ...(type === 'docker-compose' && composePath.value ? { composePath: composePath.value } : {}),
    },
  })
}

function setComposePath(value: string) {
  board.updateBlock(props.block.id, {
    provisioning: { type: 'docker-compose', composePath: value.trim() },
  })
}

// The provisioning hints (cloud provider + instance size) are advisory inputs to the
// ephemeral-environment provisioner, not commonly tuned — keep them collapsed by default.
const showProvisioning = ref(false)

// The repo + service subdirectory backing this frame, for the compose-file browser.
// A monorepo service isn't on the `github_repos` blockId link (that stays null), so
// fall back to the service catalog mapping, which carries the repo + directory.
const repoContext = computed<{ githubId: number; directory?: string | null } | undefined>(() => {
  if (props.repo) return props.repo
  const svc = services.serviceByFrameBlock[props.block.id]
  if (svc?.repoGithubId != null) return { githubId: svc.repoGithubId, directory: svc.directory }
  const r = github.repoForBlock(props.block.id)
  return r ? { githubId: r.githubId } : undefined
})

// Compose-file picker: browse the repo and pin the compose file. The Tester runs
// `docker compose -f <path>` from the CLONE ROOT, so the stored path is relative to
// the repo root (the browser starts inside the service's subdirectory for convenience).
const browseOpen = ref(false)
const pickedPath = ref<string | undefined>(undefined)
function openBrowse() {
  pickedPath.value = composePath.value || undefined
  browseOpen.value = true
}
function applyPicked() {
  if (pickedPath.value) setComposePath(pickedPath.value)
  browseOpen.value = false
}

// A service with no explicit provider inherits the active account's default (else the
// built-in `cloudflare`); show that as the selected chip so the inherited value is visible.
const effectiveProvider = computed<CloudProvider>(
  () => props.block.cloudProvider ?? accounts.activeAccount?.defaultCloudProvider ?? 'cloudflare',
)

const PROVIDERS = computed<{ value: CloudProvider; label: string }[]>(() => [
  { value: 'cloudflare', label: 'Cloudflare' },
  { value: 'docker', label: t('inspector.testConfig.providers.docker') },
  { value: 'aws', label: 'AWS' },
  { value: 'gcp', label: 'GCP' },
  { value: 'azure', label: 'Azure' },
  { value: 'custom', label: t('inspector.testConfig.providers.custom') },
])
const SIZES = computed<{ value: InstanceSize; label: string }[]>(() => [
  { value: 'small', label: t('inspector.testConfig.sizes.small') },
  { value: 'medium', label: t('inspector.testConfig.sizes.medium') },
  { value: 'large', label: t('inspector.testConfig.sizes.large') },
  { value: 'xlarge', label: t('inspector.testConfig.sizes.xlarge') },
])

function setProvider(value: CloudProvider) {
  board.updateBlock(props.block.id, { cloudProvider: value })
}
function setSize(value: InstanceSize) {
  board.updateBlock(props.block.id, { instanceSize: value })
}
</script>

<template>
  <div class="space-y-3">
    <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      {{ t('inspector.testConfig.title') }}
    </div>

    <div class="space-y-1">
      <span class="text-[11px] text-slate-400">{{ t('inspector.testConfig.provisionType') }}</span>
      <div class="flex flex-wrap gap-1">
        <UButton
          v-for="p in PROVISION_TYPES"
          :key="p.value"
          :color="provisionType === p.value ? 'primary' : 'neutral'"
          :variant="provisionType === p.value ? 'soft' : 'ghost'"
          size="xs"
          @click="setProvisionType(p.value)"
        >
          {{ p.label }}
        </UButton>
      </div>
      <p class="text-[11px] leading-snug text-slate-500">
        {{ t('inspector.testConfig.provisionTypeHint') }}
      </p>
    </div>

    <div v-if="provisionType === 'docker-compose'" class="space-y-1">
      <label class="text-[11px] text-slate-400">{{ t('inspector.testConfig.composePath') }}</label>
      <div class="flex items-center gap-1">
        <UInput
          :model-value="composePath"
          size="xs"
          class="flex-1"
          placeholder="docker-compose.yml"
          @blur="(e: FocusEvent) => setComposePath((e.target as HTMLInputElement).value)"
          @keydown.enter="
            (e: KeyboardEvent) => setComposePath((e.target as HTMLInputElement).value)
          "
        />
        <UButton
          v-if="repoContext"
          size="xs"
          variant="soft"
          color="neutral"
          icon="i-lucide-folder-search"
          :title="t('inspector.testConfig.browseRepo')"
          @click="openBrowse"
        />
      </div>
      <p class="text-[11px] leading-snug text-slate-500">
        {{ t('inspector.testConfig.composeHint') }}
      </p>
    </div>

    <UModal v-model:open="browseOpen" :title="t('inspector.testConfig.selectComposeTitle')">
      <template #body>
        <div v-if="repoContext" class="space-y-3">
          <p class="text-xs text-slate-400">
            {{ t('inspector.testConfig.selectComposeHint') }}
          </p>
          <RepoTreeBrowser
            v-model="pickedPath"
            :repo-github-id="repoContext.githubId"
            mode="file"
            :start-path="repoContext.directory ?? ''"
          />
          <div class="flex items-center justify-between gap-2">
            <p class="truncate text-xs text-slate-400">
              <template v-if="pickedPath">
                <i18n-t keypath="inspector.testConfig.selected" tag="span" scope="global">
                  <template #path>
                    <code class="text-slate-200">{{ pickedPath }}</code>
                  </template>
                </i18n-t>
              </template>
              <template v-else>{{ t('inspector.testConfig.noFileSelected') }}</template>
            </p>
            <UButton size="xs" color="primary" :disabled="!pickedPath" @click="applyPicked">
              {{ t('inspector.testConfig.useThisFile') }}
            </UButton>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Provisioning hints: advisory inputs to the ephemeral-environment provisioner.
         Collapsed by default — most services never tune them. -->
    <div class="border-t border-slate-800 pt-2">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 text-start text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
        @click="showProvisioning = !showProvisioning"
      >
        <UIcon
          :name="showProvisioning ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="h-3.5 w-3.5"
        />
        {{ t('inspector.testConfig.provisioningTitle') }}
      </button>

      <div v-if="showProvisioning" class="mt-2 space-y-3">
        <p class="text-[11px] leading-snug text-slate-500">
          {{ t('inspector.testConfig.provisioningHint') }}
        </p>

        <div class="space-y-1">
          <span class="text-[11px] text-slate-400">{{
            t('inspector.testConfig.cloudProvider')
          }}</span>
          <div class="flex flex-wrap gap-1">
            <UButton
              v-for="p in PROVIDERS"
              :key="p.value"
              :color="effectiveProvider === p.value ? 'primary' : 'neutral'"
              :variant="effectiveProvider === p.value ? 'soft' : 'ghost'"
              size="xs"
              @click="setProvider(p.value)"
            >
              {{ p.label }}
            </UButton>
          </div>
        </div>

        <div class="space-y-1">
          <span class="text-[11px] text-slate-400">{{
            t('inspector.testConfig.instanceSize')
          }}</span>
          <div class="flex flex-wrap gap-1">
            <UButton
              v-for="s in SIZES"
              :key="s.value"
              :color="(block.instanceSize ?? 'medium') === s.value ? 'primary' : 'neutral'"
              :variant="(block.instanceSize ?? 'medium') === s.value ? 'soft' : 'ghost'"
              size="xs"
              @click="setSize(s.value)"
            >
              {{ s.label }}
            </UButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
