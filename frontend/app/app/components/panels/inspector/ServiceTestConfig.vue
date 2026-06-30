<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type {
  Block,
  CloudProvider,
  InstanceSize,
  ProvisionType,
  ServiceProvisioning,
} from '~/types/domain'
import type {
  KubernetesManifestSource,
  KubernetesRenderer,
  ProvisioningOverlayCandidate,
  ProvisioningRecommendation,
} from '@cat-factory/contracts'
import RepoTreeBrowser from '~/components/github/RepoTreeBrowser.vue'

// Service-level (frame) configuration: the service-owned PROVISIONING — the provision
// TYPE this service produces (`infraless` / `docker-compose` / `kubernetes` / `custom`)
// plus the in-repo specifics it owns (the "what + where"): where its kubernetes manifests
// live (colocated path or a separate repo) + the renderer, its compose path, or the custom
// manifest id it pins. The WORKSPACE configures HOW each type is handled (the engine +
// connection); this view only owns the "what + where". Autodiscovery suggests a compose path
// when the service is added.
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
const infra = useInfraConfigStore()
const { t } = useI18n()

// The custom-manifest-type catalog feeds the `custom` picker. Cheap + shared (coalesced).
// The repo list backs the detect-from-repo affordance (owner/name lookup).
onMounted(() => {
  void infra.ensureLoaded()
  void github.ensureLoaded()
})

// The service's declared provision type (absent ⇒ treated as `infraless`: no environment
// is stood up for the Tester). Switching type MERGES onto the existing provisioning so each
// type's in-repo specifics survive toggling away and back (only the branch matching the type
// is meaningful — the others are ignored at provision time).
const provisionType = computed<ProvisionType>(() => props.block.provisioning?.type ?? 'infraless')
const composePath = computed(() => props.block.provisioning?.composePath ?? '')
const localDevOnly = computed(() => props.block.provisioning?.localDevOnly === true)
// Local kube manifest-source edit state, seeded once per block from the persisted (and
// already-validated) source. Driving the inputs from local refs rather than the
// discriminated persisted object keeps the repo/ref across a colocated<->separate toggle
// and lets a half-entered source live in the form WITHOUT writing a value the server would
// reject (the schema requires a non-empty repo for `separate` and a non-empty path for
// both). We only persist the source once it's valid (see commitManifestSource).
const kubeSourceType = ref<'colocated' | 'separate'>('colocated')
const kubeRepo = ref('')
const kubeRef = ref('')
const kubePath = ref('')
const kubeRenderer = ref<KubernetesRenderer>('raw')
// Seed the local kube edit refs from a persisted manifest source. Reused by the per-block
// watch AND after a detect-from-repo run (which mutates provisioning without changing block.id,
// so the watch wouldn't re-fire on its own).
function seedKubeSource(src?: KubernetesManifestSource) {
  kubeSourceType.value = src?.type ?? 'colocated'
  kubePath.value = src?.path ?? ''
  kubeRenderer.value = src?.renderer ?? 'raw'
  kubeRepo.value = src?.type === 'separate' ? src.repo : ''
  kubeRef.value = src?.type === 'separate' ? (src.ref ?? '') : ''
}
watch(
  () => props.block.id,
  () => seedKubeSource(props.block.provisioning?.manifestSource),
  {
    immediate: true,
  },
)
const customManifestId = computed(() => props.block.provisioning?.manifestId ?? '')
const customManifestPath = computed(() => props.block.provisioning?.manifestPath ?? '')

const PROVISION_TYPES = computed<{ value: ProvisionType; label: string }[]>(() => [
  { value: 'infraless', label: t('inspector.testConfig.provisionTypes.infraless') },
  { value: 'docker-compose', label: t('inspector.testConfig.provisionTypes.docker-compose') },
  { value: 'kubernetes', label: t('inspector.testConfig.provisionTypes.kubernetes') },
  { value: 'custom', label: t('inspector.testConfig.provisionTypes.custom') },
])

const RENDERERS = computed<{ value: KubernetesRenderer; label: string }[]>(() => [
  { value: 'raw', label: t('inspector.testConfig.renderers.raw') },
  { value: 'kustomize', label: t('inspector.testConfig.renderers.kustomize') },
])

const customTypeItems = computed(() =>
  infra.customTypes.map((c) => ({ label: `${c.label} (${c.manifestId})`, value: c.manifestId })),
)

// Merge a partial onto the current provisioning, preserving the other branches' fields.
function patchProvisioning(patch: Partial<ServiceProvisioning>) {
  const current: ServiceProvisioning = props.block.provisioning ?? { type: 'infraless' }
  board.updateBlock(props.block.id, { provisioning: { ...current, ...patch } })
}

function setProvisionType(type: ProvisionType) {
  patchProvisioning({ type })
}

function setComposePath(value: string) {
  patchProvisioning({ type: 'docker-compose', composePath: value.trim() })
}

function setLocalDevOnly(value: boolean) {
  patchProvisioning({ localDevOnly: value })
}

// Build the discriminated manifest source from the local edit state and persist it ONLY
// when it satisfies the schema (a non-empty repo for `separate`, a non-empty path for both);
// an incomplete edit sets the type but omits the source, so we never PATCH a value the
// server would 422 on.
function commitManifestSource() {
  const path = kubePath.value.trim()
  const rendererPart = kubeRenderer.value === 'kustomize' ? { renderer: kubeRenderer.value } : {}
  let next: KubernetesManifestSource | undefined
  if (kubeSourceType.value === 'separate') {
    const repo = kubeRepo.value.trim()
    const ref = kubeRef.value.trim()
    if (repo && path)
      next = { type: 'separate', repo, path, ...(ref ? { ref } : {}), ...rendererPart }
  } else if (path) {
    next = { type: 'colocated', path, ...rendererPart }
  }
  patchProvisioning(next ? { type: 'kubernetes', manifestSource: next } : { type: 'kubernetes' })
}

function setKubeSourceType(type: 'colocated' | 'separate') {
  kubeSourceType.value = type
  commitManifestSource()
}
function setKubeRepo(value: string) {
  kubeRepo.value = value
  commitManifestSource()
}
function setKubeRef(value: string) {
  kubeRef.value = value
  commitManifestSource()
}
function setKubePath(value: string) {
  kubePath.value = value
  commitManifestSource()
}
function setKubeRenderer(value: KubernetesRenderer) {
  kubeRenderer.value = value
  commitManifestSource()
}

function setCustomManifestId(value: string) {
  patchProvisioning({ type: 'custom', manifestId: value || undefined })
}

function setCustomManifestPath(value: string) {
  patchProvisioning({ type: 'custom', manifestPath: value.trim() || undefined })
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

// Repo-path picker, shared by the compose file (`docker compose -f <path>`) and the
// kubernetes colocated manifests path. The stored path is relative to the repo root (the
// browser starts inside the service's subdirectory for convenience).
const browseOpen = ref(false)
const browseTarget = ref<'compose' | 'k8s'>('compose')
const pickedPath = ref<string | undefined>(undefined)
function openBrowse(target: 'compose' | 'k8s') {
  browseTarget.value = target
  pickedPath.value = (target === 'compose' ? composePath.value : kubePath.value) || undefined
  browseOpen.value = true
}
function applyPicked() {
  if (pickedPath.value) {
    if (browseTarget.value === 'compose') setComposePath(pickedPath.value)
    else setKubePath(pickedPath.value)
  }
  browseOpen.value = false
}

// Auto-detect (slice 11): read the repo checkout-free and propose a NON-BINDING provisioning
// config. The user always confirms — the result prefills the form (and the kube edit refs) but
// every field stays editable, and the engine-level URL/namespace suggestions are surfaced
// read-only (the workspace handler owns them). Nothing is persisted server-side by detection.
const detecting = ref(false)
const detectError = ref(false)
const detectResult = ref<ProvisioningRecommendation | null>(null)

// A detection result is scoped to the inspected block — clear it (and any error) when the
// selection changes, so block B never shows block A's stale recommendation / overlay chips.
watch(
  () => props.block.id,
  () => {
    detectResult.value = null
    detectError.value = false
  },
)

async function detectFromRepo() {
  const ctx = repoContext.value
  if (!ctx) return
  const repo = github.repoFor(ctx.githubId)
  if (!repo) {
    detectError.value = true
    return
  }
  detecting.value = true
  detectError.value = false
  try {
    const rec = await infra.detectProvisioning({
      owner: repo.owner,
      repo: repo.name,
      ...(ctx.directory ? { directory: ctx.directory } : {}),
      // Prioritize the option matching the currently-selected tab (kubernetes vs
      // docker-compose); the detector falls back to the other when the preferred isn't found.
      prefer: provisionType.value,
    })
    detectResult.value = rec
    // Only prefill when the detector actually inferred something. A `detected: false`
    // recommendation is `infraless`; applying it would WIPE the service's existing
    // provisioning (board.updateBlock persists immediately). Leave the current config
    // untouched and just surface the "nothing found" note.
    if (rec.detected) {
      board.updateBlock(props.block.id, { provisioning: rec.provisioning })
      if (rec.provisioning.type === 'kubernetes') seedKubeSource(rec.provisioning.manifestSource)
    }
  } catch {
    detectError.value = true
  } finally {
    detecting.value = false
  }
}

// Switch the recommended manifest path to a different overlay candidate (the user's pick).
function applyOverlay(candidate: ProvisioningOverlayCandidate) {
  setKubePath(candidate.path)
}

function provisionTypeLabel(type: ProvisionType): string {
  return t(`inspector.testConfig.provisionTypes.${type}`)
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

    <!-- Auto-detect a recommended provisioning config from the repo (slice 11). Non-binding:
         it prefills the form below + the kube edit refs; the user confirms/edits everything. -->
    <div v-if="repoContext" class="space-y-2 rounded border border-slate-800 bg-slate-900/40 p-2">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] text-slate-400">{{ t('inspector.testConfig.detect.title') }}</span>
        <UButton
          size="xs"
          variant="soft"
          color="primary"
          icon="i-lucide-wand-sparkles"
          :loading="detecting"
          @click="detectFromRepo"
        >
          {{ t('inspector.testConfig.detect.button') }}
        </UButton>
      </div>
      <p class="text-[11px] leading-snug text-slate-500">
        {{ t('inspector.testConfig.detect.hint') }}
      </p>

      <p v-if="detectError" class="text-[11px] text-rose-300/80">
        {{ t('inspector.testConfig.detect.error') }}
      </p>

      <template v-if="detectResult && !detecting">
        <p v-if="!detectResult.detected" class="text-[11px] text-amber-300/80">
          {{ t('inspector.testConfig.detect.none') }}
        </p>
        <template v-else>
          <p class="text-[11px] text-emerald-300/80">
            {{
              t('inspector.testConfig.detect.applied', {
                type: provisionTypeLabel(detectResult.provisioning.type),
              })
            }}
          </p>

          <div v-if="detectResult.overlayCandidates?.length" class="space-y-1">
            <span class="text-[11px] text-slate-400">{{
              t('inspector.testConfig.detect.overlayTitle')
            }}</span>
            <div class="flex flex-wrap gap-1">
              <UButton
                v-for="o in detectResult.overlayCandidates"
                :key="o.path"
                :color="kubePath === o.path ? 'primary' : 'neutral'"
                :variant="kubePath === o.path ? 'soft' : 'ghost'"
                size="xs"
                @click="applyOverlay(o)"
              >
                {{ o.name }}
              </UButton>
            </div>
          </div>

          <p v-if="detectResult.urlSource" class="text-[11px] text-slate-500">
            {{
              t('inspector.testConfig.detect.urlSource', { source: detectResult.urlSource.source })
            }}
          </p>
          <p v-if="detectResult.namespace" class="text-[11px] text-slate-500">
            {{ t('inspector.testConfig.detect.namespace', { namespace: detectResult.namespace }) }}
          </p>

          <ul v-if="detectResult.notes.length" class="space-y-0.5">
            <li
              v-for="(n, i) in detectResult.notes"
              :key="i"
              class="flex items-start gap-1.5 text-[11px] leading-snug text-slate-500"
            >
              <span :class="n.confidence === 'high' ? 'text-emerald-400/70' : 'text-amber-400/70'">
                {{
                  n.confidence === 'high'
                    ? t('inspector.testConfig.detect.confidenceHigh')
                    : t('inspector.testConfig.detect.confidenceLow')
                }}
              </span>
              <span>{{ n.message }}</span>
            </li>
          </ul>
        </template>
      </template>
    </div>

    <div v-if="provisionType === 'docker-compose'" class="space-y-2">
      <div class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('inspector.testConfig.composePath')
        }}</label>
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
            @click="openBrowse('compose')"
          />
        </div>
        <p class="text-[11px] leading-snug text-slate-500">
          {{ t('inspector.testConfig.composeHint') }}
        </p>
      </div>
      <UCheckbox
        :model-value="localDevOnly"
        :label="t('inspector.testConfig.localDevOnly')"
        size="xs"
        @update:model-value="(v: boolean | 'indeterminate') => setLocalDevOnly(v === true)"
      />
    </div>

    <!-- kubernetes: where the per-PR manifests live (the "what/where"). The engine + cluster
         connection (the "how") is configured per-type in the Infrastructure window. -->
    <div v-if="provisionType === 'kubernetes'" class="space-y-2">
      <div class="space-y-1">
        <span class="text-[11px] text-slate-400">{{
          t('inspector.testConfig.manifestSourceLabel')
        }}</span>
        <div class="flex flex-wrap gap-1">
          <UButton
            :color="kubeSourceType === 'colocated' ? 'primary' : 'neutral'"
            :variant="kubeSourceType === 'colocated' ? 'soft' : 'ghost'"
            size="xs"
            @click="setKubeSourceType('colocated')"
          >
            {{ t('inspector.testConfig.sourceColocated') }}
          </UButton>
          <UButton
            :color="kubeSourceType === 'separate' ? 'primary' : 'neutral'"
            :variant="kubeSourceType === 'separate' ? 'soft' : 'ghost'"
            size="xs"
            @click="setKubeSourceType('separate')"
          >
            {{ t('inspector.testConfig.sourceSeparate') }}
          </UButton>
        </div>
      </div>

      <div v-if="kubeSourceType === 'separate'" class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('inspector.testConfig.manifestRepo')
        }}</label>
        <UInput
          :model-value="kubeRepo"
          size="xs"
          class="font-mono"
          placeholder="acme/preview-manifests"
          @blur="(e: FocusEvent) => setKubeRepo((e.target as HTMLInputElement).value)"
          @keydown.enter="(e: KeyboardEvent) => setKubeRepo((e.target as HTMLInputElement).value)"
        />
      </div>
      <div v-if="kubeSourceType === 'separate'" class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('inspector.testConfig.manifestRef')
        }}</label>
        <UInput
          :model-value="kubeRef"
          size="xs"
          class="font-mono"
          placeholder="main"
          @blur="(e: FocusEvent) => setKubeRef((e.target as HTMLInputElement).value)"
          @keydown.enter="(e: KeyboardEvent) => setKubeRef((e.target as HTMLInputElement).value)"
        />
      </div>

      <div class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('inspector.testConfig.manifestPath')
        }}</label>
        <div class="flex items-center gap-1">
          <UInput
            :model-value="kubePath"
            size="xs"
            class="flex-1 font-mono"
            placeholder="k8s/preview"
            @blur="(e: FocusEvent) => setKubePath((e.target as HTMLInputElement).value)"
            @keydown.enter="(e: KeyboardEvent) => setKubePath((e.target as HTMLInputElement).value)"
          />
          <UButton
            v-if="repoContext && kubeSourceType === 'colocated'"
            size="xs"
            variant="soft"
            color="neutral"
            icon="i-lucide-folder-search"
            :title="t('inspector.testConfig.browseRepo')"
            @click="openBrowse('k8s')"
          />
        </div>
        <p class="text-[11px] leading-snug text-slate-500">
          {{ t('inspector.testConfig.manifestPathHint') }}
        </p>
      </div>

      <div class="space-y-1">
        <span class="text-[11px] text-slate-400">{{
          t('inspector.testConfig.rendererLabel')
        }}</span>
        <div class="flex flex-wrap gap-1">
          <UButton
            v-for="r in RENDERERS"
            :key="r.value"
            :color="kubeRenderer === r.value ? 'primary' : 'neutral'"
            :variant="kubeRenderer === r.value ? 'soft' : 'ghost'"
            size="xs"
            @click="setKubeRenderer(r.value)"
          >
            {{ r.label }}
          </UButton>
        </div>
        <p class="text-[11px] leading-snug text-slate-500">
          {{ t('inspector.testConfig.rendererHint') }}
        </p>
      </div>
    </div>

    <!-- custom: pin the custom manifest type this service produces (matched to a remote-custom
         handler the workspace configures). -->
    <div v-if="provisionType === 'custom'" class="space-y-2">
      <div class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('inspector.testConfig.customManifestId')
        }}</label>
        <USelect
          v-if="customTypeItems.length"
          :model-value="customManifestId"
          :items="customTypeItems"
          size="xs"
          :placeholder="t('inspector.testConfig.customManifestIdPlaceholder')"
          @update:model-value="(v: string) => setCustomManifestId(v)"
        />
        <p v-else class="text-[11px] leading-snug text-amber-300/80">
          {{ t('inspector.testConfig.customNoTypes') }}
        </p>
        <p class="text-[11px] leading-snug text-slate-500">
          {{ t('inspector.testConfig.customManifestIdHint') }}
        </p>
      </div>
      <div class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('inspector.testConfig.customManifestPath')
        }}</label>
        <UInput
          :model-value="customManifestPath"
          size="xs"
          class="font-mono"
          @blur="(e: FocusEvent) => setCustomManifestPath((e.target as HTMLInputElement).value)"
          @keydown.enter="
            (e: KeyboardEvent) => setCustomManifestPath((e.target as HTMLInputElement).value)
          "
        />
      </div>
    </div>

    <UModal
      v-model:open="browseOpen"
      :title="
        browseTarget === 'compose'
          ? t('inspector.testConfig.selectComposeTitle')
          : t('inspector.testConfig.selectManifestTitle')
      "
    >
      <template #body>
        <div v-if="repoContext" class="space-y-3">
          <p class="text-xs text-slate-400">
            {{
              browseTarget === 'compose'
                ? t('inspector.testConfig.selectComposeHint')
                : t('inspector.testConfig.selectManifestHint')
            }}
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
