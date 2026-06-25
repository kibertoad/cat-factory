<script setup lang="ts">
// The Sandbox surface: a parallel place to test prompts and models against graded
// fixtures, without touching the board. Three tabs — Experiments (define a matrix of
// prompt versions × models × fixtures for one agent kind, run it, read the graded grid),
// Prompts (clone a shipped baseline into an editable candidate lineage and version it),
// and Fixtures (the graded inputs each run is scored against). Loaded on demand when the
// window opens; 503 (the deployment hasn't provisioned the Sandbox DB) shows a notice.
import { computed, ref, watch } from 'vue'
import type { SandboxGrade, SandboxPromptVersion, SandboxRun } from '~/types/sandbox'

const ui = useUiStore()
const store = useSandboxStore()
const toast = useToast()

const open = computed({
  get: () => ui.sandboxOpen,
  set: (v: boolean) => (v ? ui.openSandbox() : ui.closeSandbox()),
})

const tab = ref<'experiments' | 'prompts' | 'fixtures'>('experiments')

watch(open, (isOpen) => {
  if (isOpen) void store.load()
})

// ---- experiment builder ----------------------------------------------------
const agentKind = ref('requirements-review')
const name = ref('')
const selectedPromptIds = ref<string[]>([])
const selectedModelIds = ref<string[]>([])
const selectedFixtureIds = ref<string[]>([])

const kindPrompts = computed(() => store.promptsForKind(agentKind.value))
const kindFixtures = computed(() => store.fixturesForKind(agentKind.value))

// Reset the builder selections to sensible defaults when the agent kind (or loaded data)
// changes: every baseline prompt + every fixture for the kind, no models yet.
watch(
  [agentKind, () => store.prompts, () => store.fixtures],
  () => {
    selectedPromptIds.value = kindPrompts.value
      .filter((p) => p.origin === 'baseline')
      .map((p) => p.id)
    selectedFixtureIds.value = kindFixtures.value.map((f) => f.id)
  },
  { immediate: true },
)

const cellCount = computed(
  () =>
    selectedPromptIds.value.length *
    selectedModelIds.value.length *
    selectedFixtureIds.value.length,
)

const canRun = computed(() => cellCount.value > 0 && cellCount.value <= 100)

function toggle(which: 'prompt' | 'model' | 'fixture', id: string, on: boolean) {
  const list =
    which === 'prompt'
      ? selectedPromptIds
      : which === 'model'
        ? selectedModelIds
        : selectedFixtureIds
  list.value = on ? [...new Set([...list.value, id])] : list.value.filter((x) => x !== id)
}

async function createAndRun() {
  if (!canRun.value) return
  try {
    const created = await store.createExperiment({
      name: name.value.trim() || `${agentKind.value} — sandbox run`,
      agentKind: agentKind.value,
      matrix: {
        promptVersionIds: selectedPromptIds.value,
        models: selectedModelIds.value,
        fixtureIds: selectedFixtureIds.value,
      },
    })
    name.value = ''
    toast.add({ title: 'Running experiment…', icon: 'i-lucide-flask-conical', color: 'info' })
    await store.launch(created.id)
    toast.add({ title: 'Experiment complete', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not run the experiment',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}

// ---- results grid ----------------------------------------------------------
const gradeByRun = computed(() => {
  const map = new Map<string, SandboxGrade>()
  for (const g of store.detail?.grades ?? []) map.set(g.runId, g)
  return map
})
const selectedRun = ref<SandboxRun | null>(null)

function scoreColor(score: number): string {
  if (score >= 4) return 'text-emerald-400'
  if (score >= 3) return 'text-amber-400'
  return 'text-rose-400'
}

// ---- prompt editor ---------------------------------------------------------
const editing = ref<SandboxPromptVersion | null>(null)
const editText = ref('')
const savingPrompt = ref(false)

function edit(prompt: SandboxPromptVersion) {
  editing.value = prompt
  editText.value = prompt.systemText
}

async function saveVersion() {
  if (!editing.value || !editText.value.trim()) return
  savingPrompt.value = true
  try {
    await store.saveVersion(editing.value.id, editText.value)
    toast.add({ title: 'Saved a new version', icon: 'i-lucide-check', color: 'success' })
    editing.value = null
  } catch (e) {
    toast.add({
      title: 'Could not save the version',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    savingPrompt.value = false
  }
}

async function archive(prompt: SandboxPromptVersion) {
  try {
    await store.archivePrompt(prompt.id)
    if (editing.value?.id === prompt.id) editing.value = null
  } catch (e) {
    toast.add({
      title: 'Could not archive',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}

const fixtureName = (id: string) => store.fixtures.find((f) => f.id === id)?.name ?? id
</script>

<template>
  <UModal
    v-model:open="open"
    title="Sandbox — prompt & model testing"
    description="Try prompt versions and models against graded fixtures, scored by a judge model."
    :ui="{ content: 'max-w-5xl' }"
  >
    <template #body>
      <div v-if="store.loading" class="flex items-center justify-center py-12">
        <UIcon name="i-lucide-loader-circle" class="h-6 w-6 animate-spin text-slate-400" />
      </div>

      <div
        v-else-if="!store.available"
        class="rounded-lg border border-slate-700 bg-slate-900/50 p-6 text-sm text-slate-300"
      >
        <p class="font-medium text-slate-200">The Sandbox isn't enabled for this deployment.</p>
        <p class="mt-1 text-slate-400">
          It needs its own database (a dedicated <code>SANDBOX_DB</code> on Cloudflare, or the
          <code>sandbox</code> Postgres schema on Node). Provision it and reload.
        </p>
      </div>

      <div v-else class="space-y-4">
        <UTabs
          v-model="tab"
          :items="[
            { label: 'Experiments', value: 'experiments', icon: 'i-lucide-flask-conical' },
            { label: 'Prompts', value: 'prompts', icon: 'i-lucide-file-text' },
            { label: 'Fixtures', value: 'fixtures', icon: 'i-lucide-clipboard-list' },
          ]"
        />

        <!-- ============================= EXPERIMENTS ============================= -->
        <div v-if="tab === 'experiments'" class="grid gap-4 lg:grid-cols-2">
          <!-- builder -->
          <div class="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              New experiment
            </p>

            <UFormField label="Agent">
              <USelect
                v-model="agentKind"
                :items="store.agentKinds.map((k) => ({ label: k.label, value: k.agentKind }))"
                value-key="value"
                class="w-full"
              />
            </UFormField>

            <div>
              <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                Prompt versions
              </span>
              <div class="max-h-28 space-y-1 overflow-auto pr-1">
                <label
                  v-for="p in kindPrompts"
                  :key="p.id"
                  class="flex items-center gap-2 text-sm text-slate-300"
                >
                  <UCheckbox
                    :model-value="selectedPromptIds.includes(p.id)"
                    @update:model-value="
                      (v: boolean | 'indeterminate') => toggle('prompt', p.id, v === true)
                    "
                  />
                  <span class="truncate">{{ p.name }}</span>
                  <UBadge
                    :color="p.origin === 'baseline' ? 'neutral' : 'primary'"
                    variant="soft"
                    size="xs"
                  >
                    {{ p.origin === 'baseline' ? 'baseline' : `v${p.version}` }}
                  </UBadge>
                </label>
              </div>
            </div>

            <div>
              <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                Models
              </span>
              <div class="max-h-28 space-y-1 overflow-auto pr-1">
                <label
                  v-for="m in store.selectableModels"
                  :key="m.id"
                  class="flex items-center gap-2 text-sm text-slate-300"
                >
                  <UCheckbox
                    :model-value="selectedModelIds.includes(m.id)"
                    @update:model-value="
                      (v: boolean | 'indeterminate') => toggle('model', m.id, v === true)
                    "
                  />
                  <span class="truncate">{{ m.label }}</span>
                </label>
                <p v-if="!store.selectableModels.length" class="text-xs text-slate-500">
                  No selectable models — configure a provider key or enable Cloudflare AI.
                </p>
              </div>
            </div>

            <div>
              <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                Fixtures
              </span>
              <div class="max-h-28 space-y-1 overflow-auto pr-1">
                <label
                  v-for="f in kindFixtures"
                  :key="f.id"
                  class="flex items-center gap-2 text-sm text-slate-300"
                >
                  <UCheckbox
                    :model-value="selectedFixtureIds.includes(f.id)"
                    @update:model-value="
                      (v: boolean | 'indeterminate') => toggle('fixture', f.id, v === true)
                    "
                  />
                  <span class="truncate">{{ f.name }}</span>
                </label>
                <p v-if="!kindFixtures.length" class="text-xs text-slate-500">
                  No fixtures for this agent.
                </p>
              </div>
            </div>

            <UFormField label="Name (optional)">
              <UInput v-model="name" :placeholder="`${agentKind} — sandbox run`" />
            </UFormField>

            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-500">
                {{ cellCount }} cell{{ cellCount === 1 ? '' : 's' }}
                <span v-if="cellCount > 100" class="text-rose-400"> (max 100)</span>
              </span>
              <UButton
                color="primary"
                icon="i-lucide-play"
                size="sm"
                :loading="store.launching"
                :disabled="!canRun"
                @click="createAndRun()"
              >
                Run
              </UButton>
            </div>
          </div>

          <!-- history + results -->
          <div class="space-y-3">
            <div
              v-if="store.detail"
              class="rounded-lg border border-slate-700 bg-slate-900/40 p-3"
            >
              <div class="mb-2 flex items-center justify-between">
                <p class="text-sm font-medium text-slate-200">
                  {{ store.detail.experiment.name }}
                </p>
                <UBadge variant="soft" size="xs">{{ store.detail.experiment.status }}</UBadge>
              </div>
              <div class="overflow-auto">
                <table class="w-full text-left text-xs">
                  <thead class="text-slate-500">
                    <tr>
                      <th class="py-1 pr-2 font-medium">Prompt</th>
                      <th class="py-1 pr-2 font-medium">Model</th>
                      <th class="py-1 pr-2 font-medium">Fixture</th>
                      <th class="py-1 pr-2 font-medium">Score</th>
                      <th class="py-1 font-medium">Objective</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="run in store.detail.runs"
                      :key="run.id"
                      class="cursor-pointer border-t border-slate-800 hover:bg-slate-800/40"
                      @click="selectedRun = run"
                    >
                      <td class="py-1 pr-2 text-slate-300">{{ run.promptLabel }}</td>
                      <td class="py-1 pr-2 font-mono text-[11px] text-slate-400">{{ run.model }}</td>
                      <td class="py-1 pr-2 text-slate-400">{{ fixtureName(run.fixtureId) }}</td>
                      <td class="py-1 pr-2">
                        <span
                          v-if="gradeByRun.get(run.id)"
                          :class="scoreColor(gradeByRun.get(run.id)!.weightedTotal)"
                          class="font-semibold"
                        >
                          {{ gradeByRun.get(run.id)!.weightedTotal.toFixed(2) }}
                        </span>
                        <span v-else-if="run.status === 'failed'" class="text-rose-400">failed</span>
                        <span v-else class="text-slate-600">—</span>
                      </td>
                      <td class="py-1">
                        <span
                          v-if="gradeByRun.get(run.id)?.objective"
                          :class="
                            gradeByRun.get(run.id)!.objective!.pass
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          "
                        >
                          {{ gradeByRun.get(run.id)!.objective!.caught }}/{{
                            gradeByRun.get(run.id)!.objective!.total
                          }}
                        </span>
                        <span v-else class="text-slate-600">—</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- selected cell output -->
              <div v-if="selectedRun" class="mt-3 border-t border-slate-800 pt-2">
                <p class="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                  {{ selectedRun.promptLabel }} · {{ selectedRun.model }}
                </p>
                <p v-if="selectedRun.error" class="text-xs text-rose-400">{{ selectedRun.error }}</p>
                <pre
                  v-else
                  class="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 p-2 text-[11px] text-slate-300"
                  >{{ selectedRun.outputText }}</pre
                >
                <div v-if="gradeByRun.get(selectedRun.id)" class="mt-2 space-y-0.5">
                  <p
                    v-for="d in gradeByRun.get(selectedRun.id)!.scores"
                    :key="d.key"
                    class="text-[11px] text-slate-400"
                  >
                    <span :class="scoreColor(d.score)" class="font-semibold">{{ d.score }}</span>
                    <span class="ml-1 text-slate-300">{{ d.key }}</span>
                    <span v-if="d.rationale" class="ml-1 text-slate-500">— {{ d.rationale }}</span>
                  </p>
                </div>
              </div>
            </div>

            <p class="text-[11px] uppercase tracking-wide text-slate-500">Past experiments</p>
            <div class="max-h-56 space-y-1 overflow-auto">
              <button
                v-for="x in store.experiments"
                :key="x.id"
                class="flex w-full items-center justify-between rounded-md border border-slate-800 bg-slate-900/40 px-2 py-1.5 text-left text-sm hover:bg-slate-800/50"
                @click="store.openExperiment(x.id)"
              >
                <span class="truncate text-slate-300">{{ x.name }}</span>
                <UBadge variant="soft" size="xs">{{ x.status }}</UBadge>
              </button>
              <p v-if="!store.experiments.length" class="text-xs text-slate-500">
                No experiments yet.
              </p>
            </div>
          </div>
        </div>

        <!-- ============================== PROMPTS ============================== -->
        <div v-else-if="tab === 'prompts'" class="grid gap-4 lg:grid-cols-2">
          <div class="max-h-[28rem] space-y-1.5 overflow-auto pr-1">
            <div
              v-for="p in store.prompts"
              :key="p.id"
              class="flex items-center justify-between rounded-md border border-slate-800 bg-slate-900/40 px-2.5 py-1.5 text-sm"
            >
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate text-slate-200">{{ p.name }}</span>
                  <UBadge
                    :color="p.origin === 'baseline' ? 'neutral' : 'primary'"
                    variant="soft"
                    size="xs"
                  >
                    {{ p.origin === 'baseline' ? 'baseline' : `v${p.version}` }}
                  </UBadge>
                </div>
                <span class="text-[11px] text-slate-500">{{ p.agentKind }}</span>
              </div>
              <div class="flex items-center gap-1">
                <UButton
                  icon="i-lucide-pencil"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :title="p.origin === 'baseline' ? 'Fork into a candidate' : 'Edit / version'"
                  @click="edit(p)"
                />
                <UButton
                  v-if="p.origin === 'candidate'"
                  icon="i-lucide-archive"
                  color="error"
                  variant="ghost"
                  size="xs"
                  @click="archive(p)"
                />
              </div>
            </div>
          </div>

          <div
            v-if="editing"
            class="space-y-2 rounded-lg border border-slate-700 bg-slate-900/40 p-3"
          >
            <p class="text-[11px] uppercase tracking-wide text-slate-500">
              {{ editing.origin === 'baseline' ? 'Fork' : 'New version of' }} · {{ editing.name }}
            </p>
            <UTextarea v-model="editText" :rows="16" class="w-full font-mono text-xs" autoresize />
            <div class="flex justify-end gap-2">
              <UButton color="neutral" variant="ghost" size="sm" @click="editing = null">
                Cancel
              </UButton>
              <UButton
                color="primary"
                icon="i-lucide-save"
                size="sm"
                :loading="savingPrompt"
                :disabled="!editText.trim()"
                @click="saveVersion()"
              >
                Save new version
              </UButton>
            </div>
          </div>
          <p v-else class="self-start text-xs text-slate-500">
            Pick a prompt to fork a shipped baseline or version a candidate. Each save appends an
            immutable version you can put under test.
          </p>
        </div>

        <!-- ============================== FIXTURES ============================== -->
        <div v-else class="max-h-[28rem] space-y-1.5 overflow-auto pr-1">
          <div
            v-for="f in store.fixtures"
            :key="f.id"
            class="rounded-md border border-slate-800 bg-slate-900/40 px-2.5 py-2 text-sm"
          >
            <div class="flex items-center justify-between">
              <span class="text-slate-200">{{ f.name }}</span>
              <div class="flex items-center gap-1.5">
                <UBadge variant="soft" size="xs">{{ f.kind }}</UBadge>
                <UBadge :color="f.origin === 'builtin' ? 'neutral' : 'primary'" variant="soft" size="xs">
                  {{ f.origin }}
                </UBadge>
              </div>
            </div>
            <p
              v-if="f.objective?.kind === 'findings'"
              class="mt-0.5 text-[11px] text-slate-500"
            >
              {{ f.objective.expectations.length }} graded expectation{{
                f.objective.expectations.length === 1 ? '' : 's'
              }}
            </p>
          </div>
          <p v-if="!store.fixtures.length" class="text-xs text-slate-500">No fixtures.</p>
        </div>
      </div>
    </template>
  </UModal>
</template>
