<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type {
  Block,
  FrontendBackendBinding,
  FrontendConfig,
  FrontendConfigRecommendation,
  FrontendEnvInjection,
  FrontendPackageManager,
  FrontendServeMode,
  PreviewStatus,
} from '~/types/domain'
import FrontendBindingsResolved from '~/components/panels/inspector/FrontendBindingsResolved.vue'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'

// Frontend-frame (`type: 'frontend'`) configuration: how to build, serve, and mock this
// frontend for a self-contained UI test (+ an optional browsable preview on local/node),
// and its backend bindings. Each binding names an env var the frontend reads for an upstream
// URL and where that URL resolves — a bound SERVICE frame's ephemeral env (the service under
// test), or WireMock. The bindings ARE the board's frontend→service links. Persisted as a
// serialized FrontendConfig on the block via the shared updateBlock PATCH. The fields are grouped
// into collapsible sections (all collapsed by default), with a repo-driven "Detect from repo"
// affordance that proposes most of them for the user to review + apply.
const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const auth = useAuthStore()
const preview = usePreviewStore()
const infra = useInfraConfigStore()
const github = useGitHubStore()
const { t } = useI18n()

// A browsable preview needs a long-lived host serve, so it is a local/node runtime capability
// the deployment advertises (`infrastructure.frontendPreview.supported`); the Worker reports it
// unsupported. Default to true until the auth handshake resolves so the toggle isn't briefly
// disabled on a runtime that does support it.
const previewSupported = computed(() => auth.infrastructure?.frontendPreview?.supported !== false)

const config = computed<FrontendConfig>(() => props.block.frontendConfig ?? { backendBindings: [] })
const bindings = computed(() => config.value.backendBindings ?? [])

// Merge a partial onto the current config, preserving the other fields, and persist. A field
// set to undefined is dropped (JSON.stringify omits it), so the harness default applies.
function save(patch: Partial<FrontendConfig>) {
  const base: FrontendConfig = props.block.frontendConfig ?? { backendBindings: [] }
  board.updateBlock(props.block.id, { frontendConfig: { ...base, ...patch } })
}

// A trimmed string field: an empty value clears it (undefined) so the harness default applies.
function saveText(field: keyof FrontendConfig, value: string) {
  save({ [field]: value.trim() || undefined } as Partial<FrontendConfig>)
}

// The serve port must be an integer in [1, 65535] (the contract's schema bounds). Coerce and
// clamp to a valid port, dropping anything else to undefined (clears it → the harness default),
// so an out-of-range or non-integer value never 422s the PATCH.
function saveServePort(value: string) {
  const n = Math.trunc(Number(value.trim()))
  save({ servePort: Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined })
}

const PACKAGE_MANAGERS: FrontendPackageManager[] = ['pnpm', 'npm', 'yarn']
const packageManager = computed(() => config.value.packageManager ?? 'pnpm')
const serveMode = computed<FrontendServeMode>(() => config.value.serveMode ?? 'static')
const envInjection = computed<FrontendEnvInjection>(() => config.value.envInjection ?? 'build')

// The service frames on the board a binding can point at (its ephemeral env URL becomes the
// service under test). Every other binding resolves to WireMock.
const serviceFrames = computed(() => board.frames.filter((b) => b.type === 'service'))

// USelect options for a binding's source: WireMock, or one of the service frames.
const sourceItems = computed(() => [
  { label: t('inspector.frontendConfig.bindings.mock'), value: 'mock' },
  ...serviceFrames.value.map((f) => ({ label: f.title || f.id, value: f.id })),
])

// The select value for a binding: 'mock', or the bound service block id.
function sourceValue(binding: FrontendBackendBinding): string {
  return binding.source.kind === 'service' ? binding.source.serviceBlockId : 'mock'
}

function replaceBinding(index: number, next: FrontendBackendBinding) {
  save({ backendBindings: bindings.value.map((b, i) => (i === index ? next : b)) })
}

function setBindingEnvVar(index: number, value: string) {
  const b = bindings.value[index]
  if (b) replaceBinding(index, { ...b, envVar: value.trim() })
}

function setBindingSource(index: number, value: string) {
  const b = bindings.value[index]
  if (!b) return
  const source: FrontendBackendBinding['source'] =
    value === 'mock' ? { kind: 'mock' } : { kind: 'service', serviceBlockId: value }
  replaceBinding(index, { ...b, source })
}

function addBinding() {
  // InspectorSection expands its group when a header action is clicked, so the new row is visible.
  save({ backendBindings: [...bindings.value, { envVar: '', source: { kind: 'mock' } }] })
}

function removeBinding(index: number) {
  save({ backendBindings: bindings.value.filter((_, i) => i !== index) })
}

// ---- Collapsible groups (all collapsed by default) --------------------------------------
const showBuild = ref(false)
const showServe = ref(false)
const showMocking = ref(false)
const showEnv = ref(false)
const showBindings = ref(false)
const showPreview = ref(false)

// ---- Detect from repo (preview → apply) --------------------------------------------------
// Read the frontend repo checkout-free and propose a NON-BINDING recommended config. The result
// is held as a preview the user reviews; NOTHING is persisted until they click Apply. The frontend
// frame links to its repo the same way a service does (`github_repos.block_id`).
const repoLink = computed(() => github.repoForBlock(props.block.id))
const detecting = ref(false)
const detectError = ref(false)
const detectResult = ref<FrontendConfigRecommendation | null>(null)

// A detection result is scoped to the inspected block — clear it (and any error) when the
// selection changes, so block B never shows block A's stale recommendation.
watch(
  () => props.block.id,
  () => {
    detectResult.value = null
    detectError.value = false
  },
)

async function detectFromRepo() {
  const repo = repoLink.value
  if (!repo) {
    detectError.value = true
    return
  }
  detecting.value = true
  detectError.value = false
  detectResult.value = null
  try {
    const result = await infra.detectFrontendConfig({
      owner: repo.owner,
      repo: repo.name,
      ...(config.value.directory ? { directory: config.value.directory } : {}),
    })
    detectResult.value = result
    // When nothing was detected the "none" hint tells the user to set the frontend directory —
    // that field lives in the (collapsed) Build group, so open it so the advice is actionable.
    if (!result.detected) showBuild.value = true
  } catch {
    detectError.value = true
  } finally {
    detecting.value = false
  }
}

// Apply the recommendation: overlay the proposed scalar fields, but APPEND backend bindings
// (never overwrite existing rows or their `source` — that would wipe configured service links).
// Only env-var names not already present are added.
function applyDetection() {
  const rec = detectResult.value
  if (!rec) return
  const { backendBindings: proposed, ...rest } = rec.config
  const existing = bindings.value
  const existingNames = new Set(existing.map((b) => b.envVar.trim()).filter(Boolean))
  const added = (proposed ?? []).filter((b) => b.envVar && !existingNames.has(b.envVar.trim()))
  save({ ...rest, backendBindings: [...existing, ...added] })
  // Open the groups so the user sees what changed.
  showBuild.value = true
  showServe.value = true
  if (added.length) showBindings.value = true
  detectResult.value = null
}

// ---- Browsable preview (live runtime state, distinct from the persisted toggle) ----------
// The live preview is a separate resource fetched from the preview endpoints; the store keys it
// by frame id and self-polls while it is `starting`. Only relevant on a preview-capable runtime
// with the toggle on.
const previewActive = computed(() => previewSupported.value && config.value.previewEnabled === true)
const previewState = computed(() => preview.byFrame[props.block.id])
const previewStatus = computed<PreviewStatus>(() => previewState.value?.status ?? 'stopped')
const previewBusy = computed(() => preview.busy[props.block.id] === true)
// A start/stop request error (e.g. an unsupported runtime 503s) — shown inline; distinct from a
// `failed` preview (a build that came up then broke), which carries `previewState.error`.
const previewRequestError = computed(() => preview.requestError[props.block.id])

// Exhaustive status → catalog key (tier-2 guard for the runtime-built lookup): adding a
// PreviewStatus value without a label trips the typecheck on this map.
const PREVIEW_STATUS_KEYS: Record<PreviewStatus, string> = {
  starting: 'inspector.frontendConfig.preview.status.starting',
  ready: 'inspector.frontendConfig.preview.status.ready',
  failed: 'inspector.frontendConfig.preview.status.failed',
  stopped: 'inspector.frontendConfig.preview.status.stopped',
}
const previewStatusLabel = computed(() => t(PREVIEW_STATUS_KEYS[previewStatus.value]))

// Load the current state when the preview surface becomes relevant (mount + toggling it on, or
// selecting a different frontend frame), so the inspector reflects an already-running preview.
function refreshPreview() {
  if (previewActive.value) void preview.refresh(props.block.id)
}
onMounted(refreshPreview)
watch(() => [previewActive.value, props.block.id], refreshPreview)
// Stop the store's self-poll for this frame when the inspector closes, so a `starting` preview
// doesn't keep polling in the background after the panel is gone.
onUnmounted(() => preview.stopPolling(props.block.id))
</script>

<template>
  <InspectorSection
    :title="t('inspector.frontendConfig.title')"
    :hint="t('inspector.frontendConfig.hint')"
  >
    <!-- Detect from repo: propose a config the user reviews + applies. Non-binding — nothing is
         persisted until Apply. Only shown when the frame is linked to a repo. -->
    <div
      v-if="repoLink"
      class="space-y-2 rounded border border-slate-800 bg-slate-900/40 p-2"
      data-testid="frontend-detect"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] text-slate-400">{{
          t('inspector.frontendConfig.detect.title')
        }}</span>
        <UButton
          size="xs"
          variant="soft"
          color="primary"
          icon="i-lucide-wand-sparkles"
          :loading="detecting"
          data-testid="frontend-detect-button"
          @click="detectFromRepo"
        >
          {{ t('inspector.frontendConfig.detect.button') }}
        </UButton>
      </div>
      <p class="text-[11px] leading-snug text-slate-500">
        {{ t('inspector.frontendConfig.detect.hint') }}
      </p>

      <p v-if="detectError" class="text-[11px] text-rose-300/80">
        {{ t('inspector.frontendConfig.detect.error') }}
      </p>

      <template v-if="detectResult && !detecting">
        <p v-if="!detectResult.detected" class="text-[11px] text-amber-300/80">
          {{ t('inspector.frontendConfig.detect.none') }}
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
                  ? t('inspector.frontendConfig.detect.confidenceHigh')
                  : t('inspector.frontendConfig.detect.confidenceLow')
              }}
            </span>
            <span>{{ n.message }}</span>
          </li>
        </ul>

        <div v-if="detectResult.detected" class="flex flex-wrap gap-1">
          <UButton
            size="xs"
            variant="soft"
            color="primary"
            icon="i-lucide-check"
            data-testid="frontend-detect-apply"
            @click="applyDetection"
          >
            {{ t('inspector.frontendConfig.detect.apply') }}
          </UButton>
          <UButton size="xs" variant="ghost" color="neutral" @click="detectResult = null">
            {{ t('inspector.frontendConfig.detect.dismiss') }}
          </UButton>
        </div>
      </template>
    </div>

    <!-- Build: package manager + frontend directory + install command + build script + output dir -->
    <InspectorSection v-model:open="showBuild" :title="t('inspector.frontendConfig.groups.build')">
      <div class="space-y-1">
        <span class="text-[11px] text-slate-400">{{
          t('inspector.frontendConfig.packageManager')
        }}</span>
        <div class="flex flex-wrap gap-1">
          <UButton
            v-for="pm in PACKAGE_MANAGERS"
            :key="pm"
            :color="packageManager === pm ? 'primary' : 'neutral'"
            :variant="packageManager === pm ? 'soft' : 'ghost'"
            size="xs"
            @click="save({ packageManager: pm })"
          >
            {{ pm }}
          </UButton>
        </div>
      </div>

      <div class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('inspector.frontendConfig.directory')
        }}</label>
        <UInput
          :model-value="config.directory ?? ''"
          size="xs"
          class="font-mono"
          maxlength="400"
          placeholder="frontend/"
          @blur="(e: FocusEvent) => saveText('directory', (e.target as HTMLInputElement).value)"
          @keydown.enter="
            (e: KeyboardEvent) => saveText('directory', (e.target as HTMLInputElement).value)
          "
        />
        <p class="text-[11px] leading-snug text-slate-500">
          {{ t('inspector.frontendConfig.directoryHint') }}
        </p>
      </div>

      <div class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('inspector.frontendConfig.installCommand')
        }}</label>
        <UInput
          :model-value="config.installCommand ?? ''"
          size="xs"
          class="font-mono"
          maxlength="400"
          placeholder="pnpm install --frozen-lockfile"
          @blur="
            (e: FocusEvent) => saveText('installCommand', (e.target as HTMLInputElement).value)
          "
          @keydown.enter="
            (e: KeyboardEvent) => saveText('installCommand', (e.target as HTMLInputElement).value)
          "
        />
      </div>

      <div class="grid grid-cols-2 gap-2">
        <div class="space-y-1">
          <label class="text-[11px] text-slate-400">{{
            t('inspector.frontendConfig.buildScript')
          }}</label>
          <UInput
            :model-value="config.buildScript ?? ''"
            size="xs"
            class="font-mono"
            maxlength="200"
            placeholder="build"
            @blur="(e: FocusEvent) => saveText('buildScript', (e.target as HTMLInputElement).value)"
            @keydown.enter="
              (e: KeyboardEvent) => saveText('buildScript', (e.target as HTMLInputElement).value)
            "
          />
        </div>
        <div class="space-y-1">
          <label class="text-[11px] text-slate-400">{{
            t('inspector.frontendConfig.outputDir')
          }}</label>
          <UInput
            :model-value="config.outputDir ?? ''"
            size="xs"
            class="font-mono"
            maxlength="400"
            placeholder="dist"
            @blur="(e: FocusEvent) => saveText('outputDir', (e.target as HTMLInputElement).value)"
            @keydown.enter="
              (e: KeyboardEvent) => saveText('outputDir', (e.target as HTMLInputElement).value)
            "
          />
        </div>
      </div>
    </InspectorSection>

    <!-- Serve: mode (static vs command) + serve script (command mode) + port -->
    <InspectorSection v-model:open="showServe" :title="t('inspector.frontendConfig.groups.serve')">
      <div class="space-y-1">
        <span class="text-[11px] text-slate-400">{{
          t('inspector.frontendConfig.serveMode')
        }}</span>
        <div class="flex flex-wrap gap-1">
          <UButton
            :color="serveMode === 'static' ? 'primary' : 'neutral'"
            :variant="serveMode === 'static' ? 'soft' : 'ghost'"
            size="xs"
            @click="save({ serveMode: 'static' })"
          >
            {{ t('inspector.frontendConfig.serveStatic') }}
          </UButton>
          <UButton
            :color="serveMode === 'command' ? 'primary' : 'neutral'"
            :variant="serveMode === 'command' ? 'soft' : 'ghost'"
            size="xs"
            @click="save({ serveMode: 'command' })"
          >
            {{ t('inspector.frontendConfig.serveCommand') }}
          </UButton>
        </div>
        <!-- Explain each mode, and disambiguate from the separate envInjection axis. -->
        <p class="text-[11px] leading-snug text-slate-500">
          <span class="text-slate-400">{{ t('inspector.frontendConfig.serveStatic') }}:</span>
          {{ t('inspector.frontendConfig.serveStaticDesc') }}
        </p>
        <p class="text-[11px] leading-snug text-slate-500">
          <span class="text-slate-400">{{ t('inspector.frontendConfig.serveCommand') }}:</span>
          {{ t('inspector.frontendConfig.serveCommandDesc') }}
        </p>
        <p class="text-[11px] leading-snug text-slate-500/80">
          {{ t('inspector.frontendConfig.serveEnvAxisNote') }}
        </p>
      </div>

      <div v-if="serveMode === 'command'" class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('inspector.frontendConfig.serveScript')
        }}</label>
        <UInput
          :model-value="config.serveScript ?? ''"
          size="xs"
          class="font-mono"
          maxlength="200"
          placeholder="preview"
          @blur="(e: FocusEvent) => saveText('serveScript', (e.target as HTMLInputElement).value)"
          @keydown.enter="
            (e: KeyboardEvent) => saveText('serveScript', (e.target as HTMLInputElement).value)
          "
        />
      </div>

      <div class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('inspector.frontendConfig.servePort')
        }}</label>
        <UInput
          :model-value="config.servePort != null ? String(config.servePort) : ''"
          type="number"
          min="1"
          max="65535"
          step="1"
          size="xs"
          class="font-mono"
          placeholder="4173"
          @blur="(e: FocusEvent) => saveServePort((e.target as HTMLInputElement).value)"
        />
      </div>
    </InspectorSection>

    <!-- Mocking: WireMock mappings dir -->
    <InspectorSection
      v-model:open="showMocking"
      :title="t('inspector.frontendConfig.groups.mocking')"
    >
      <div class="space-y-1">
        <label class="text-[11px] text-slate-400">{{
          t('inspector.frontendConfig.mockMappingsPath')
        }}</label>
        <UInput
          :model-value="config.mockMappingsPath ?? ''"
          size="xs"
          class="font-mono"
          maxlength="400"
          placeholder="mocks/"
          @blur="
            (e: FocusEvent) => saveText('mockMappingsPath', (e.target as HTMLInputElement).value)
          "
          @keydown.enter="
            (e: KeyboardEvent) => saveText('mockMappingsPath', (e.target as HTMLInputElement).value)
          "
        />
        <p class="text-[11px] leading-snug text-slate-500">
          {{ t('inspector.frontendConfig.mockMappingsHint') }}
        </p>
      </div>
    </InspectorSection>

    <!-- Env injection: build-time env vars vs a runtime window.env shim -->
    <InspectorSection
      v-model:open="showEnv"
      :title="t('inspector.frontendConfig.groups.envInjection')"
    >
      <div class="space-y-1">
        <div class="flex flex-wrap gap-1">
          <UButton
            :color="envInjection === 'build' ? 'primary' : 'neutral'"
            :variant="envInjection === 'build' ? 'soft' : 'ghost'"
            size="xs"
            @click="save({ envInjection: 'build' })"
          >
            {{ t('inspector.frontendConfig.envBuild') }}
          </UButton>
          <UButton
            :color="envInjection === 'runtime' ? 'primary' : 'neutral'"
            :variant="envInjection === 'runtime' ? 'soft' : 'ghost'"
            size="xs"
            @click="save({ envInjection: 'runtime' })"
          >
            {{ t('inspector.frontendConfig.envRuntime') }}
          </UButton>
        </div>
        <p class="text-[11px] leading-snug text-slate-500">
          {{ t('inspector.frontendConfig.envInjectionHint') }}
        </p>
      </div>
    </InspectorSection>

    <!-- Backend bindings: env var → upstream. These double as the board's frontend→service links. -->
    <InspectorSection
      v-model:open="showBindings"
      :title="t('inspector.frontendConfig.groups.bindings')"
      :hint="t('inspector.frontendConfig.bindings.hint')"
      :count="bindings.length"
    >
      <template #actions>
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-plus"
          @click="addBinding"
        />
      </template>
      <div class="space-y-2">
        <div v-if="bindings.length" class="space-y-1.5">
          <div v-for="(b, i) in bindings" :key="i" class="flex items-center gap-1">
            <UInput
              :model-value="b.envVar"
              size="xs"
              class="flex-1 font-mono"
              maxlength="200"
              placeholder="PUB_BACKEND_URL"
              @blur="(e: FocusEvent) => setBindingEnvVar(i, (e.target as HTMLInputElement).value)"
              @keydown.enter="
                (e: KeyboardEvent) => setBindingEnvVar(i, (e.target as HTMLInputElement).value)
              "
            />
            <USelect
              :model-value="sourceValue(b)"
              :items="sourceItems"
              size="xs"
              class="flex-1"
              @update:model-value="(v: string) => setBindingSource(i, v)"
            />
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-x"
              :title="t('inspector.frontendConfig.bindings.remove')"
              @click="removeBinding(i)"
            />
          </div>
        </div>
        <div v-else class="text-[11px] text-slate-500">
          {{ t('inspector.frontendConfig.bindings.empty') }}
        </div>

        <!-- How the bindings resolve RIGHT NOW: each env var → a bound service's live ephemeral
             URL, or WireMock — plus the duplicate-env-var warning. The same view a UI-test run
             would resolve against (shared helpers), so what you see is what a run will drive. -->
        <div class="border-t border-slate-800/60 pt-2">
          <FrontendBindingsResolved :config="config" />
        </div>
      </div>
    </InspectorSection>

    <!-- Browsable preview (local/node only; the Worker reports it unsupported). -->
    <InspectorSection
      v-model:open="showPreview"
      :title="t('inspector.frontendConfig.groups.preview')"
    >
      <div>
        <UCheckbox
          :model-value="previewSupported && config.previewEnabled === true"
          :label="t('inspector.frontendConfig.previewEnabled')"
          :disabled="!previewSupported"
          size="xs"
          @update:model-value="
            (v: boolean | 'indeterminate') =>
              save({ previewEnabled: v === true ? true : undefined })
          "
        />
        <p class="mt-1 text-[11px] leading-snug text-slate-500">
          {{
            previewSupported
              ? t('inspector.frontendConfig.previewHint')
              : t('inspector.frontendConfig.previewUnsupported')
          }}
        </p>

        <!-- Live preview control: start / open (clickable URL) / stop, reflecting the runtime state. -->
        <div v-if="previewActive" class="mt-2 space-y-1.5" data-testid="preview-panel">
          <div class="flex items-center gap-2">
            <span
              class="text-[11px] font-medium"
              :class="{
                'text-emerald-400': previewStatus === 'ready',
                'text-amber-400': previewStatus === 'starting',
                'text-rose-400': previewStatus === 'failed',
                'text-slate-400': previewStatus === 'stopped',
              }"
              data-testid="preview-status"
            >
              {{ previewStatusLabel }}
            </span>

            <UButton
              v-if="previewStatus === 'ready' && previewState?.url"
              :to="previewState.url"
              target="_blank"
              rel="noopener"
              size="xs"
              variant="soft"
              color="primary"
              trailing-icon="i-lucide-external-link"
              data-testid="preview-url"
            >
              {{ t('inspector.frontendConfig.preview.open') }}
            </UButton>
          </div>

          <div class="flex flex-wrap gap-1">
            <UButton
              v-if="previewStatus === 'stopped' || previewStatus === 'failed'"
              size="xs"
              variant="soft"
              color="primary"
              icon="i-lucide-play"
              :loading="previewBusy"
              data-testid="preview-start"
              @click="preview.start(props.block.id)"
            >
              {{ t('inspector.frontendConfig.preview.start') }}
            </UButton>
            <UButton
              v-if="previewStatus === 'ready' || previewStatus === 'starting'"
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-square"
              :loading="previewBusy"
              data-testid="preview-stop"
              @click="preview.stop(props.block.id)"
            >
              {{ t('inspector.frontendConfig.preview.stop') }}
            </UButton>
          </div>

          <p
            v-if="previewStatus === 'failed' && previewState?.error"
            class="text-[11px] leading-snug text-rose-400"
            data-testid="preview-error"
          >
            {{ previewState.error }}
          </p>

          <p
            v-if="previewRequestError"
            class="text-[11px] leading-snug text-rose-400"
            data-testid="preview-request-error"
          >
            {{ previewRequestError }}
          </p>
        </div>
      </div>
    </InspectorSection>
  </InspectorSection>
</template>
