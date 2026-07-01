<script setup lang="ts">
import { computed } from 'vue'
import type {
  Block,
  FrontendBackendBinding,
  FrontendConfig,
  FrontendEnvInjection,
  FrontendPackageManager,
  FrontendServeMode,
} from '~/types/domain'

// Frontend-frame (`type: 'frontend'`) configuration: how to build, serve, and mock this
// frontend for a self-contained UI test (+ an optional browsable preview on local/node),
// and its backend bindings. Each binding names an env var the frontend reads for an upstream
// URL and where that URL resolves — a bound SERVICE frame's ephemeral env (the service under
// test), or WireMock. The bindings ARE the board's frontend→service links. Persisted as a
// serialized FrontendConfig on the block via the shared updateBlock PATCH.
const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const { t } = useI18n()

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
  save({ backendBindings: [...bindings.value, { envVar: '', source: { kind: 'mock' } }] })
}

function removeBinding(index: number) {
  save({ backendBindings: bindings.value.filter((_, i) => i !== index) })
}
</script>

<template>
  <div class="space-y-3">
    <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      {{ t('inspector.frontendConfig.title') }}
    </div>
    <p class="text-[11px] leading-snug text-slate-500">
      {{ t('inspector.frontendConfig.hint') }}
    </p>

    <!-- Package manager -->
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

    <!-- Build: install command + build script + output dir -->
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
        @blur="(e: FocusEvent) => saveText('installCommand', (e.target as HTMLInputElement).value)"
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

    <!-- Serve: mode (static vs command) + serve script (command mode) + port -->
    <div class="space-y-1">
      <span class="text-[11px] text-slate-400">{{ t('inspector.frontendConfig.serveMode') }}</span>
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
      <p class="text-[11px] leading-snug text-slate-500">
        {{ t('inspector.frontendConfig.serveModeHint') }}
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

    <div class="grid grid-cols-2 gap-2">
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
      </div>
    </div>

    <!-- Env injection: build-time env vars vs a runtime window.env shim -->
    <div class="space-y-1">
      <span class="text-[11px] text-slate-400">{{
        t('inspector.frontendConfig.envInjection')
      }}</span>
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

    <!-- Backend bindings: env var → upstream. These double as the board's frontend→service links. -->
    <div class="space-y-2 border-t border-slate-800 pt-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('inspector.frontendConfig.bindings.title') }}
        </span>
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-plus"
          @click="addBinding"
        />
      </div>
      <p class="text-[11px] leading-snug text-slate-500">
        {{ t('inspector.frontendConfig.bindings.hint') }}
      </p>

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
    </div>

    <!-- Browsable preview (local/node only). -->
    <div class="border-t border-slate-800 pt-2">
      <UCheckbox
        :model-value="config.previewEnabled === true"
        :label="t('inspector.frontendConfig.previewEnabled')"
        size="xs"
        @update:model-value="
          (v: boolean | 'indeterminate') => save({ previewEnabled: v === true ? true : undefined })
        "
      />
      <p class="mt-1 text-[11px] leading-snug text-slate-500">
        {{ t('inspector.frontendConfig.previewHint') }}
      </p>
    </div>
  </div>
</template>
