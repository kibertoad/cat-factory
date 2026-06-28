<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Block, CloudProvider, InstanceSize } from '~/types/domain'
import RepoTreeBrowser from '~/components/github/RepoTreeBrowser.vue'

// Service-level (frame) configuration: where the Tester's local-mode infra comes
// from (a docker-compose path, or an explicit "no infra dependencies" toggle — a
// Tester pipeline can't start until one is set), plus the cloud provider + instance
// size the service's container jobs run on. Autodiscovery suggests a compose path
// when the service is added; it can be set/changed here later — or browsed for in
// the backing repository.
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

const composePath = computed(() => props.block.testComposePath ?? '')
const noInfra = computed(() => props.block.noInfraDependencies === true)

// The default test environment a task under this service is spawned with. `local`
// stands the dependencies up via docker-compose (or "no infra"); `ephemeral` runs
// against a provisioned environment. A task can override it per-task in its agent
// settings. Absent ⇒ the built-in `ephemeral`.
type TestEnvironment = 'local' | 'ephemeral'
const TEST_ENVIRONMENTS = computed<{ value: TestEnvironment; label: string; hint: string }[]>(
  () => [
    {
      value: 'ephemeral',
      label: t('inspector.testConfig.env.ephemeral'),
      hint: t('inspector.testConfig.env.ephemeralHint'),
    },
    {
      value: 'local',
      label: t('inspector.testConfig.env.local'),
      hint: t('inspector.testConfig.env.localHint'),
    },
  ],
)
const effectiveTestEnv = computed<TestEnvironment>(
  () => props.block.defaultTestEnvironment ?? 'ephemeral',
)
function setDefaultTestEnv(value: TestEnvironment) {
  board.updateBlock(props.block.id, { defaultTestEnvironment: value })
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

function setComposePath(value: string) {
  board.updateBlock(props.block.id, { testComposePath: value.trim() })
}
function toggleNoInfra(value: boolean) {
  board.updateBlock(props.block.id, { noInfraDependencies: value })
}

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

const missingInfra = computed(() => !noInfra.value && composePath.value.trim() === '')
</script>

<template>
  <div class="space-y-3">
    <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      {{ t('inspector.testConfig.title') }}
    </div>

    <div class="space-y-1">
      <span class="text-[11px] text-slate-400">{{ t('inspector.testConfig.defaultEnv') }}</span>
      <div class="flex flex-wrap gap-1">
        <UButton
          v-for="e in TEST_ENVIRONMENTS"
          :key="e.value"
          :color="effectiveTestEnv === e.value ? 'primary' : 'neutral'"
          :variant="effectiveTestEnv === e.value ? 'soft' : 'ghost'"
          size="xs"
          :title="e.hint"
          @click="setDefaultTestEnv(e.value)"
        >
          {{ e.label }}
        </UButton>
      </div>
      <p class="text-[11px] leading-snug text-slate-500">
        {{ t('inspector.testConfig.defaultEnvHint') }}
      </p>
    </div>

    <div class="space-y-1">
      <label class="text-[11px] text-slate-400">{{ t('inspector.testConfig.composePath') }}</label>
      <div class="flex items-center gap-1">
        <UInput
          :model-value="composePath"
          size="xs"
          class="flex-1"
          placeholder="docker-compose.yml"
          :disabled="noInfra"
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
          :disabled="noInfra"
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

    <label class="flex items-center gap-2 text-[11px] text-slate-400">
      <UCheckbox
        :model-value="noInfra"
        @update:model-value="(v: boolean | 'indeterminate') => toggleNoInfra(v === true)"
      />
      {{ t('inspector.testConfig.noInfra') }}
    </label>

    <p v-if="missingInfra" class="text-[11px] leading-snug text-amber-500">
      {{ t('inspector.testConfig.missingInfra') }}
    </p>

    <!-- Provisioning hints: advisory inputs to the ephemeral-environment provisioner.
         Collapsed by default — most services never tune them. -->
    <div class="border-t border-slate-800 pt-2">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
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
