<script setup lang="ts">
// Workspace settings: the Model Configuration screen. A workspace keeps a library of
// MODEL PRESETS — each a named base model applied to every agent kind plus optional
// per-agent overrides. A task picks a preset (or the workspace default); the chosen
// preset decides which model each pipeline step runs on, unless the task pins a model
// directly. The built-in default ("Kimi K2.7") points every agent at Kimi K2.7; a
// second built-in points everything at GLM-5.2.
//
// Styled as a dark full-screen window like the agent-output review overlay rather than
// a light modal, so the text stays readable regardless of the OS colour-mode
// preference. The list view shows each preset; the editor view creates/edits one with a
// base-model picker plus a filterable per-agent override list.
import { computed, ref, watch } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import type { AgentKind } from '~/types/domain'
import type { ModelPreset } from '~/types/model-presets'
import { MODEL_CONFIGURABLE_SYSTEM_KINDS } from '~/utils/catalog'
import { cachingLabel, contextLabel, costLabel, displayFlavor, isSelectable } from '~/stores/models'

const { t } = useI18n()
const ui = useUiStore()
const models = useModelsStore()
const presets = useModelPresetsStore()
const agents = useAgentsStore()
const creds = useVendorCredentialsStore()
const workspace = useWorkspaceStore()
const toast = useToast()
const { confirm } = useConfirm()

const open = computed({
  get: () => ui.modelConfigOpen,
  set: (v: boolean) => (v ? ui.openModelConfig() : ui.closeModelConfig()),
})

// null = the preset list; an object = the create/edit form for one preset.
interface EditorState {
  id?: string
  name: string
  baseModelId: string
  overrides: Record<string, string>
  isDefault: boolean
}
const editor = ref<EditorState | null>(null)
const busy = ref(false)
// Narrows the agent-kind override rows, for finding a kind fast in a long catalog.
const filter = ref('')

// The palette archetypes PLUS the engine-driven kinds that still run an LLM
// (spec-writer, merger, the fixers/resolver). The pure gates run no model, so they
// stay out — exactly the set the per-agent override list should cover.
const configurableKinds = computed(() => [...agents.archetypes, ...MODEL_CONFIGURABLE_SYSTEM_KINDS])
const filteredKinds = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return configurableKinds.value
  return configurableKinds.value.filter(
    (a) => a.label.toLowerCase().includes(q) || String(a.kind).toLowerCase().includes(q),
  )
})

watch(
  open,
  (isOpen) => {
    if (isOpen) {
      editor.value = null
      filter.value = ''
      void models.ensureLoaded(workspace.workspaceId ?? undefined)
      if (workspace.workspaceId) void creds.load(workspace.workspaceId)
    }
  },
  { immediate: true },
)

onKeyStroke('Escape', () => {
  if (!open.value) return
  // Esc backs out of the editor first, then closes the panel.
  if (editor.value) editor.value = null
  else open.value = false
})

/** The selectable catalog models, as `{ id, label, suffix }` for a dropdown. */
const selectableModels = computed(() => {
  const configured = creds.configuredVendors
  return models.models
    .filter((m) => isSelectable(m, configured))
    .map((m) => {
      const flavor = displayFlavor(m, configured)
      const ctx = contextLabel(flavor.contextTokens)
      const price =
        costLabel(flavor) ??
        (flavor.quotaBased ? t('settings.modelConfiguration.quota') : undefined)
      // Surface caching in the suffix: a cache-less flavour (the Workers-AI hot path)
      // re-bills its whole growing prompt every turn, which the user can act on.
      const caching = cachingLabel(flavor)
      const suffix = [flavor.providerLabel, ctx, price, caching].filter(Boolean).join(' · ')
      return {
        id: m.id,
        label: m.label,
        suffix,
        icon: flavor.quotaBased ? 'i-lucide-infinity' : 'i-lucide-cpu',
      }
    })
})

/** A readable label for a model id (catalog label + provider, else the raw id). */
function modelLabel(id: string | undefined): string {
  if (!id) return '—'
  const m = models.getModel(id)
  if (!m) return id
  return `${m.label} · ${displayFlavor(m, creds.configuredVendors).providerLabel}`
}

// ---- preset list -----------------------------------------------------------
const sortedPresets = computed(() => [...presets.presets].sort((a, b) => a.createdAt - b.createdAt))

function startCreate() {
  editor.value = {
    name: '',
    baseModelId: selectableModels.value[0]?.id ?? 'kimi-k2.7',
    overrides: {},
    isDefault: false,
  }
  filter.value = ''
}
function startEdit(p: ModelPreset) {
  editor.value = {
    id: p.id,
    name: p.name,
    baseModelId: p.baseModelId,
    overrides: { ...p.overrides },
    isDefault: p.isDefault,
  }
  filter.value = ''
}

async function setDefault(p: ModelPreset) {
  if (p.isDefault) return
  busy.value = true
  try {
    await presets.update(p.id, { isDefault: true })
  } catch (e) {
    fail(t('settings.modelConfiguration.toast.setDefaultFailed'), e)
  } finally {
    busy.value = false
  }
}

async function remove(p: ModelPreset) {
  const ok = await confirm({
    title: t('settings.modelConfiguration.confirmDelete.title'),
    description: t('settings.modelConfiguration.confirmDelete.body', { name: p.name }),
    variant: 'destructive',
    confirmLabel: t('common.delete'),
    icon: 'i-lucide-trash-2',
  })
  if (!ok) return
  busy.value = true
  try {
    await presets.remove(p.id)
  } catch (e) {
    fail(t('settings.modelConfiguration.toast.deleteFailed'), e)
  } finally {
    busy.value = false
  }
}

// ---- editor ----------------------------------------------------------------
/** The base-model dropdown items. */
const baseMenu = computed(() => [
  selectableModels.value.map((m) => ({
    label: `${m.label} · ${m.suffix}`,
    icon: m.icon,
    onSelect: () => {
      if (editor.value) editor.value.baseModelId = m.id
    },
  })),
])

/** A per-kind override dropdown: "Use base model" reset plus the catalog. */
function overrideMenu(kind: AgentKind) {
  return [
    [
      {
        label: t('settings.modelConfiguration.editor.useBaseModel'),
        icon: 'i-lucide-rotate-ccw',
        onSelect: () => setOverride(kind, null),
      },
      ...selectableModels.value.map((m) => ({
        label: `${m.label} · ${m.suffix}`,
        icon: m.icon,
        onSelect: () => setOverride(kind, m.id),
      })),
    ],
  ]
}
function setOverride(kind: AgentKind, modelId: string | null) {
  if (!editor.value) return
  const next = { ...editor.value.overrides }
  if (modelId) next[kind] = modelId
  else delete next[kind]
  editor.value.overrides = next
}
/** The label on a kind's override button: its override model, else "Base model". */
function overrideLabel(kind: AgentKind): string {
  const id = editor.value?.overrides[kind]
  return id ? modelLabel(id) : t('settings.modelConfiguration.editor.baseModel')
}

// The model Kaizen grading resolves to under the preset being edited (`overrides.kaizen ??
// base`). The Kaizen grader is an inline LLM call, so a model that is usable ONLY via an
// individual subscription can't drive it — grading is skipped for such a model. Warn the
// user so they pick a provider-backed model for the Kaizen override.
const kaizenModelId = computed(() =>
  editor.value ? (editor.value.overrides['kaizen'] ?? editor.value.baseModelId) : undefined,
)
const kaizenModelIndividualOnly = computed(() => {
  const m = models.getModel(kaizenModelId.value)
  return !!m && m.available === true && m.inlineUsable === false
})

async function save() {
  const e = editor.value
  if (!e) return
  if (!e.name.trim()) {
    fail(
      t('settings.modelConfiguration.toast.nameRequiredTitle'),
      new Error(t('settings.modelConfiguration.toast.nameRequiredBody')),
    )
    return
  }
  busy.value = true
  try {
    if (e.id) {
      await presets.update(e.id, {
        name: e.name.trim(),
        baseModelId: e.baseModelId,
        overrides: e.overrides,
        isDefault: e.isDefault,
      })
    } else {
      await presets.create({
        name: e.name.trim(),
        baseModelId: e.baseModelId,
        overrides: e.overrides,
        isDefault: e.isDefault,
      })
    }
    editor.value = null
  } catch (err) {
    fail(t('settings.modelConfiguration.toast.saveFailed'), err)
  } finally {
    busy.value = false
  }
}

function fail(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}
</script>

<template>
  <Teleport to="body">
    <Transition name="reader-fade">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex max-h-[100dvh] flex-col bg-slate-950/96 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
      >
        <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15"
          >
            <UIcon name="i-lucide-cpu" class="h-5 w-5 text-indigo-300" />
          </div>
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold text-white">
              {{ t('settings.modelConfiguration.title') }}
            </h1>
            <p class="truncate text-xs text-slate-500">
              {{ t('settings.modelConfiguration.subtitle') }}
            </p>
          </div>
          <UButton
            v-if="editor"
            icon="i-lucide-arrow-left"
            :ui="{ leadingIcon: 'rtl:-scale-x-100', trailingIcon: 'rtl:-scale-x-100' }"
            color="neutral"
            variant="ghost"
            size="sm"
            class="ms-auto"
            @click="
              () => {
                editor = null
              }
            "
          >
            {{ t('settings.modelConfiguration.back') }}
          </UButton>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="sm"
            :class="editor ? '' : 'ms-auto'"
            :title="t('settings.modelConfiguration.closeEsc')"
            @click="
              () => {
                open = false
              }
            "
          />
        </header>

        <div class="flex-1 overflow-auto px-6 py-6">
          <div class="mx-auto max-w-3xl space-y-5">
            <!-- ===== list view ===== -->
            <template v-if="!editor">
              <div class="flex items-center justify-between">
                <p class="text-sm leading-relaxed text-slate-400">
                  <i18n-t
                    keypath="settings.modelConfiguration.list.intro"
                    scope="global"
                    tag="span"
                  >
                    <template #baseModel>
                      <span class="text-slate-300">{{
                        t('settings.modelConfiguration.list.introBaseModel')
                      }}</span>
                    </template>
                  </i18n-t>
                </p>
                <UButton
                  icon="i-lucide-plus"
                  color="primary"
                  size="sm"
                  class="shrink-0"
                  @click="startCreate"
                >
                  {{ t('settings.modelConfiguration.list.newPreset') }}
                </UButton>
              </div>

              <p v-if="models.models.length === 0" class="py-4 text-center text-sm text-slate-500">
                {{ t('settings.modelConfiguration.list.loadingCatalog') }}
              </p>

              <div v-else class="space-y-3">
                <div
                  v-for="p in sortedPresets"
                  :key="p.id"
                  class="rounded-xl border border-slate-800 bg-slate-900/50 p-4"
                >
                  <div class="flex items-center gap-2">
                    <span class="truncate text-sm font-semibold text-slate-100">{{ p.name }}</span>
                    <UBadge v-if="p.isDefault" color="primary" variant="subtle" size="xs">
                      {{ t('settings.modelConfiguration.list.default') }}
                    </UBadge>
                    <div class="ms-auto flex items-center gap-1">
                      <UButton
                        v-if="!p.isDefault"
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        icon="i-lucide-star"
                        :loading="busy"
                        :title="t('settings.modelConfiguration.list.setDefaultTitle')"
                        @click="setDefault(p)"
                      />
                      <UButton
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        icon="i-lucide-pencil"
                        :title="t('settings.modelConfiguration.list.editTitle')"
                        @click="startEdit(p)"
                      />
                      <UButton
                        size="xs"
                        variant="ghost"
                        color="error"
                        icon="i-lucide-trash-2"
                        :disabled="p.isDefault"
                        :loading="busy"
                        :title="
                          p.isDefault
                            ? t('settings.modelConfiguration.list.deleteDisabledTitle')
                            : t('settings.modelConfiguration.list.deleteTitle')
                        "
                        @click="remove(p)"
                      />
                    </div>
                  </div>
                  <div class="mt-1.5 text-[11px] text-slate-400">
                    {{ t('settings.modelConfiguration.list.basePrefix') }}
                    <span class="text-slate-300">{{ modelLabel(p.baseModelId) }}</span>
                    <span v-if="Object.keys(p.overrides).length">
                      ·
                      {{
                        t(
                          'settings.modelConfiguration.list.overrideCount',
                          { count: Object.keys(p.overrides).length },
                          Object.keys(p.overrides).length,
                        )
                      }}
                    </span>
                  </div>
                </div>
                <p
                  v-if="sortedPresets.length === 0"
                  class="py-6 text-center text-sm text-slate-500"
                >
                  {{ t('settings.modelConfiguration.list.empty') }}
                </p>
              </div>
            </template>

            <!-- ===== editor view ===== -->
            <template v-else>
              <div class="space-y-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <div>
                  <label
                    class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
                  >
                    {{ t('settings.modelConfiguration.editor.nameLabel') }}
                  </label>
                  <UInput
                    v-model="editor.name"
                    :placeholder="t('settings.modelConfiguration.editor.namePlaceholder')"
                    size="sm"
                    class="w-full"
                  />
                </div>

                <div>
                  <label
                    class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
                  >
                    {{ t('settings.modelConfiguration.editor.baseModelLabel') }}
                  </label>
                  <UDropdownMenu
                    :items="baseMenu"
                    :ui="{ content: 'max-h-80 overflow-y-auto z-[60]' }"
                  >
                    <UButton
                      size="sm"
                      color="primary"
                      variant="subtle"
                      trailing-icon="i-lucide-chevron-down"
                      class="w-full justify-between"
                    >
                      <span class="truncate">{{ modelLabel(editor.baseModelId) }}</span>
                    </UButton>
                  </UDropdownMenu>
                </div>

                <label class="flex items-center gap-2 text-sm text-slate-300">
                  <UCheckbox v-model="editor.isDefault" />
                  {{ t('settings.modelConfiguration.editor.makeDefault') }}
                </label>
              </div>

              <div>
                <div class="mb-1 flex items-center justify-between">
                  <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {{ t('settings.modelConfiguration.editor.perAgentOverrides') }}
                  </span>
                </div>
                <div
                  v-if="kaizenModelIndividualOnly"
                  class="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-950/40 p-3 text-[13px] text-amber-200/90"
                >
                  <UIcon
                    name="i-lucide-triangle-alert"
                    class="mt-0.5 h-4 w-4 shrink-0 text-amber-400"
                  />
                  <span>{{
                    t('settings.modelConfiguration.editor.kaizenIndividualWarning', {
                      model: modelLabel(kaizenModelId),
                    })
                  }}</span>
                </div>
                <UInput
                  v-model="filter"
                  icon="i-lucide-search"
                  size="sm"
                  :placeholder="t('settings.modelConfiguration.editor.filterPlaceholder')"
                  class="mb-3 w-full"
                />
                <div
                  class="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/50"
                >
                  <div
                    v-for="a in filteredKinds"
                    :key="a.kind"
                    class="flex items-center gap-3 px-4 py-3"
                  >
                    <UIcon
                      :name="a.icon"
                      class="h-4 w-4 shrink-0"
                      :style="{ color: a.color }"
                      :title="a.description"
                    />
                    <div class="min-w-0 flex-1" :title="a.description">
                      <p class="truncate text-sm text-slate-200">{{ a.label }}</p>
                    </div>
                    <UDropdownMenu
                      :items="overrideMenu(a.kind)"
                      :ui="{ content: 'max-h-80 overflow-y-auto z-[60]' }"
                    >
                      <UButton
                        size="xs"
                        :color="editor.overrides[a.kind] ? 'primary' : 'neutral'"
                        :variant="editor.overrides[a.kind] ? 'subtle' : 'soft'"
                        trailing-icon="i-lucide-chevron-down"
                        class="w-64 shrink-0 justify-between"
                      >
                        <span class="truncate">{{ overrideLabel(a.kind) }}</span>
                      </UButton>
                    </UDropdownMenu>
                  </div>
                  <p
                    v-if="filteredKinds.length === 0"
                    class="px-4 py-6 text-center text-sm text-slate-500"
                  >
                    {{ t('settings.modelConfiguration.editor.noAgentsMatch', { filter }) }}
                  </p>
                </div>
              </div>

              <div class="flex items-center justify-end gap-2">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  @click="
                    () => {
                      editor = null
                    }
                  "
                >
                  {{ t('common.cancel') }}
                </UButton>
                <UButton color="primary" size="sm" :loading="busy" @click="save">
                  {{
                    editor.id
                      ? t('settings.modelConfiguration.editor.saveChanges')
                      : t('settings.modelConfiguration.editor.createPreset')
                  }}
                </UButton>
              </div>
            </template>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.reader-fade-enter-active,
.reader-fade-leave-active {
  transition: opacity 0.18s ease;
}
.reader-fade-enter-from,
.reader-fade-leave-to {
  opacity: 0;
}
</style>
