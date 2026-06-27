<script setup lang="ts">
// Local-mode-only settings: the warm-container pool + per-repo checkout reuse. These are
// a per-DEPLOYMENT singleton stored in the DB (they replaced the LOCAL_POOL_* / HARNESS_*
// env vars), so a developer tunes them here instead of editing .env. The warm pool keeps
// idle harness containers ready and re-leases one (preferring repo affinity) to each run —
// far faster startup than a cold container per run. Saving applies the new sizing to the
// running service immediately (the pool is resized live — no restart needed); in-flight
// runs keep the container they already hold, and the checkout config applies to containers
// started after the save.
import { reactive, ref, watch } from 'vue'

const ui = useUiStore()
const store = useLocalSettingsStore()
const toast = useToast()

const open = computed({
  get: () => ui.localModeSettingsOpen,
  set: (v: boolean) => (v ? ui.openLocalModeSettings() : ui.closeLocalModeSettings()),
})

const saving = ref(false)

// Editable draft. `idleMinutes` and `cleanKeep` are friendlier renderings of the stored
// `pool.idleTtlMs` (ms) and `checkout.cleanKeep` (string[]).
const draft = reactive({
  size: 0,
  minWarm: 0,
  max: null as number | null,
  idleMinutes: 10,
  workspaceRoot: '/workspace',
  cleanKeep: 'node_modules,.venv,target,.gradle,.pnpm-store',
})

function syncDraft() {
  const s = store.settings
  if (!s) return
  draft.size = s.pool.size
  draft.minWarm = s.pool.minWarm
  draft.max = s.pool.max
  draft.idleMinutes = Math.round(s.pool.idleTtlMs / 60_000)
  draft.workspaceRoot = s.checkout.workspaceRoot
  draft.cleanKeep = s.checkout.cleanKeep.join(',')
}

// Load + hydrate the draft whenever the panel opens.
watch(
  open,
  (isOpen) => {
    if (isOpen) void store.load().then(syncDraft)
  },
  { immediate: true },
)
watch(() => store.settings, syncDraft)

async function save() {
  const cleanKeep = draft.cleanKeep
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  saving.value = true
  try {
    await store.save({
      pool: {
        size: Math.max(0, Math.floor(draft.size)),
        minWarm: Math.max(0, Math.floor(draft.minWarm)),
        max: draft.max == null ? null : Math.max(0, Math.floor(draft.max)),
        idleTtlMs: Math.max(0, Math.floor(draft.idleMinutes * 60_000)),
      },
      checkout: { workspaceRoot: draft.workspaceRoot.trim() || '/workspace', cleanKeep },
    })
    toast.add({ title: 'Local settings saved', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not save local settings',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Local mode" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="space-y-6">
        <p class="text-xs text-slate-400">
          Tuning for the local container runner — stored on this machine's deployment (it replaced
          the <code>LOCAL_POOL_*</code> / <code>HARNESS_*</code> env vars). Saving resizes the warm
          pool live — no restart needed; in-flight runs keep the container they already hold.
        </p>

        <!-- Warm container pool -->
        <section class="space-y-3">
          <div>
            <h4 class="text-sm font-semibold text-slate-200">Warm container pool</h4>
            <p class="text-[11px] text-slate-400">
              Keep idle harness containers ready and re-lease one (preferring a container that
              already holds the run's repo) instead of cold-starting per run. Pool size 0 disables
              it. Requires a Docker-family runtime (Docker/Podman/OrbStack/Colima); ignored on Apple
              <code>container</code>.
            </p>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UFormField label="Pool size" help="Max idle warm containers. 0 = pooling off.">
              <UInput v-model.number="draft.size" type="number" :min="0" size="sm" />
            </UFormField>
            <UFormField label="Pre-warm at boot" help="Containers started when the service boots.">
              <UInput v-model.number="draft.minWarm" type="number" :min="0" size="sm" />
            </UFormField>
            <UFormField label="Max containers" help="Hard cap (leased + idle). Blank = pool size.">
              <UInput
                v-model.number="draft.max"
                type="number"
                :min="0"
                size="sm"
                placeholder="(pool size)"
              />
            </UFormField>
            <UFormField label="Idle timeout (minutes)" help="Evict an idle pooled container after.">
              <UInput v-model.number="draft.idleMinutes" type="number" :min="0" size="sm" />
            </UFormField>
          </div>
        </section>

        <!-- Checkout reuse -->
        <section class="space-y-3 border-t border-slate-800 pt-6">
          <div>
            <h4 class="text-sm font-semibold text-slate-200">Checkout reuse</h4>
            <p class="text-[11px] text-slate-400">
              When a warm container already holds the run's repo, the harness reuses its per-repo
              checkout (clean sweep + fetch + switch branch) instead of cloning fresh.
            </p>
          </div>
          <UFormField
            label="Workspace root"
            help="Absolute in-container directory the reused checkout lives under."
          >
            <UInput v-model="draft.workspaceRoot" size="sm" placeholder="/workspace" />
          </UFormField>
          <UFormField
            label="Keep on clean (comma-separated)"
            help="Dependency-cache directories the per-run clean sweep preserves."
          >
            <UInput
              v-model="draft.cleanKeep"
              size="sm"
              placeholder="node_modules,.venv,target,.gradle,.pnpm-store"
            />
          </UFormField>
        </section>

        <div class="flex justify-end">
          <UButton color="primary" icon="i-lucide-save" :loading="saving" @click="save">
            Save
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
