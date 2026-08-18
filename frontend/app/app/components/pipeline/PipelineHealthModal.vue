<script setup lang="ts">
// Startup advisory for unhealthy pipelines. Opened once per session from the board page when
// `usePipelineHealth` reports any issue. Lists:
//   • new built-in pipelines the workspace doesn't have yet (ADD them);
//   • invalid pipelines (unknown agent kind / bad shape) — DELETE a custom one, RESEED a built-in;
//   • outdated built-ins (a newer catalog definition is available) — RESEED to adopt it;
//   • RETIRED built-ins (withdrawn from the catalog) — REMOVE them; there is nothing left to
//     reseed from, which is why they are the one built-in the backend lets a delete through.
// Adding a new built-in and reseeding an existing one are the same reseed call (it creates or
// updates by catalog id). Detection is client-side (see usePipelineHealth); the actions hit the
// pipelines store.
const { t } = useI18n()
const ui = useUiStore()
const pipelines = usePipelinesStore()
const { invalid, outdated, newPipelines, retired, hasIssues } = usePipelineHealth()
// Failures go through the shared conflict presenter rather than a raw `toast.add`: the refusals
// this screen actually provokes are 409s (a recurring schedule still points at the pipeline), and
// those carry a machine-readable `details.reason` the presenter turns into translated remedy copy.
// Dumping `error.message` instead would put untranslated backend prose in front of every non-English
// user — on the one screen whose whole purpose is telling them what to do next.
const { present } = usePipelineErrorToast()
// Deleting is the one irreversible action on this screen (see the note above `reseedAll`), so it
// routes through the shared destructive confirm rather than firing on first click.
const { confirmAction, toastDone } = useConfirmAction()

const open = computed({
  get: () => ui.pipelineHealthOpen,
  set: (v: boolean) => {
    if (!v) ui.closePipelineHealth()
  },
})

// Per-pipeline in-flight ids, so each row's button shows its own spinner.
const busy = ref<Set<string>>(new Set())
const isBusy = (id: string) => busy.value.has(id)
const anyBusy = computed(() => busy.value.size > 0)
/**
 * The pipeline whose confirm prompt is open, tracked apart from `busy` because a confirm is not work
 * in flight: the row must not spin while the human reads the prompt.
 *
 * It still LOCKS every other control. `useConfirm` is a singleton, so a second Delete click
 * supersedes the pending request and settles it `false`: the first pipeline was then silently not
 * deleted, and nothing on screen said so.
 */
const confirmingId = ref<string | null>(null)
/** True while any row is mid-action OR holding an open confirm. Every control here reads this. */
const locked = computed(() => anyBusy.value || confirmingId.value !== null)

/** `failTitleKey` is an i18n KEY (not resolved copy) — `present` uses it only when the failure has
 *  no mapped conflict reason of its own. Resolves `true` only when the action actually settled, so
 *  a caller can withhold its success toast on a refusal. */
async function run(id: string, action: () => Promise<unknown>, failTitleKey: string) {
  busy.value = new Set(busy.value).add(id)
  try {
    await action()
    return true
  } catch (e) {
    present(e, failTitleKey)
    return false
  } finally {
    const next = new Set(busy.value)
    next.delete(id)
    busy.value = next
  }
}

const reseed = (id: string) =>
  run(id, () => pipelines.reseed(id), 'pipeline.health.toast.reseedFailed')

/**
 * Confirm, then delete. Both removal buttons land here (UX-93): a reseed restores what the catalog
 * says, but a delete is the one irreversible action on this screen — a built-in the catalog no
 * longer defines cannot be reseeded back — and it used to fire on first click, one stray Enter away
 * from destroying a workspace's pipeline. The confirm NAMES the pipeline, because the two sections
 * render several rows of near-identical buttons and "which one did I just delete" is unanswerable
 * afterwards.
 */
async function confirmRemove(pipeline: { id: string; name: string }, failTitleKey: string) {
  // The entry guard is the authoritative half of the lock the buttons show: it holds for any future
  // caller, and it is what makes "one confirmed click per pipeline" true rather than aspirational.
  if (locked.value) return
  confirmingId.value = pipeline.id
  const confirmed = await confirmAction('remove', pipeline.name).finally(() => {
    confirmingId.value = null
  })
  if (!confirmed) return
  if (await run(pipeline.id, () => pipelines.removePipeline(pipeline.id), failTitleKey))
    toastDone('remove', pipeline.name)
}

const remove = (pipeline: { id: string; name: string }) =>
  confirmRemove(pipeline, 'pipeline.health.toast.deleteFailed')
// Same call as `remove`, different failure copy: the retired section says "Remove" (the pipeline is
// gone from the catalog), so a failure toast reading "could not DELETE" would name an action the
// user was never offered. This is only the FALLBACK title — the likely failure here is a recurring
// schedule still pointing at the pipeline, which arrives as a 409 the presenter words itself.
const removeRetired = (pipeline: { id: string; name: string }) =>
  confirmRemove(pipeline, 'pipeline.health.toast.removeFailed')

// Removals are deliberately per-row with no bulk twin, unlike the reseeds below: one confirmed
// click per pipeline is the point.

/** Reseed every reseedable pipeline (new + outdated built-ins + invalid built-ins) in one go. */
async function reseedAll() {
  const ids = [
    ...newPipelines.value.map((p) => p.id),
    ...invalid.value.filter((h) => h.pipeline.builtin).map((h) => h.pipeline.id),
    ...outdated.value.map((h) => h.pipeline.id),
  ]
  for (const id of new Set(ids)) await reseed(id)
}

const reseedableCount = computed(
  () =>
    new Set([
      ...newPipelines.value.map((p) => p.id),
      ...invalid.value.filter((h) => h.pipeline.builtin).map((h) => h.pipeline.id),
      ...outdated.value.map((h) => h.pipeline.id),
    ]).size,
)
</script>

<template>
  <UModal v-model:open="open" :title="t('pipeline.health.title')" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div v-if="!hasIssues" class="py-6 text-center text-sm text-slate-400">
        <UIcon name="i-lucide-check-circle-2" class="mx-auto mb-2 h-8 w-8 text-emerald-400" />
        {{ t('pipeline.health.allValid') }}
      </div>

      <div v-else class="space-y-5">
        <!-- New built-in pipelines the workspace can add. -->
        <section v-if="newPipelines.length" class="space-y-2">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-sparkles" class="h-4 w-4 text-emerald-400" />
            <h3 class="text-sm font-semibold text-slate-200">
              {{ t('pipeline.health.newHeading') }}
            </h3>
          </div>
          <p class="text-[11px] text-slate-500">{{ t('pipeline.health.newDescription') }}</p>
          <ul class="space-y-2">
            <li
              v-for="p in newPipelines"
              :key="p.id"
              class="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3"
            >
              <div class="min-w-0">
                <span class="truncate text-sm font-medium text-slate-100 capitalize">{{
                  p.name
                }}</span>
              </div>
              <UButton
                size="xs"
                color="primary"
                variant="subtle"
                icon="i-lucide-plus"
                :loading="isBusy(p.id)"
                :disabled="locked"
                @click="reseed(p.id)"
              >
                {{ t('pipeline.health.add') }}
              </UButton>
            </li>
          </ul>
        </section>

        <!-- Invalid: unknown agent kinds or a broken shape. -->
        <section v-if="invalid.length" class="space-y-2">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-triangle-alert" class="h-4 w-4 text-rose-400" />
            <h3 class="text-sm font-semibold text-slate-200">
              {{ t('pipeline.health.invalidHeading') }}
            </h3>
          </div>
          <p class="text-[11px] text-slate-500">
            {{ t('pipeline.health.invalidDescription') }}
          </p>
          <ul class="space-y-2">
            <li
              v-for="h in invalid"
              :key="h.pipeline.id"
              class="rounded-lg border border-slate-800 bg-slate-900/40 p-3"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="truncate text-sm font-medium text-slate-100">
                      {{ h.pipeline.name }}
                    </span>
                    <UBadge v-if="h.pipeline.builtin" color="neutral" variant="subtle" size="xs">
                      {{ t('pipeline.health.builtinBadge') }}
                    </UBadge>
                  </div>
                  <ul class="mt-1 space-y-0.5">
                    <li
                      v-for="(p, i) in h.problems"
                      :key="i"
                      class="text-[11px]"
                      :class="p.type === 'outdated' ? 'text-amber-400/80' : 'text-rose-400/90'"
                    >
                      {{ p.message }}
                    </li>
                  </ul>
                </div>
                <UButton
                  v-if="h.pipeline.builtin"
                  size="xs"
                  color="primary"
                  variant="subtle"
                  icon="i-lucide-rotate-ccw"
                  :loading="isBusy(h.pipeline.id)"
                  :disabled="locked"
                  @click="reseed(h.pipeline.id)"
                >
                  {{ t('pipeline.health.reseed') }}
                </UButton>
                <UButton
                  v-else
                  size="xs"
                  color="error"
                  variant="subtle"
                  icon="i-lucide-trash-2"
                  :loading="isBusy(h.pipeline.id)"
                  :disabled="locked"
                  @click="remove(h.pipeline)"
                >
                  {{ t('pipeline.health.delete') }}
                </UButton>
              </div>
            </li>
          </ul>
        </section>

        <!-- Retired built-ins: withdrawn from the catalog, so the only action is removal. -->
        <section v-if="retired.length" class="space-y-2">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-archive-x" class="h-4 w-4 text-slate-400" />
            <h3 class="text-sm font-semibold text-slate-200">
              {{ t('pipeline.health.retiredHeading') }}
            </h3>
          </div>
          <p class="text-[11px] text-slate-500">{{ t('pipeline.health.retiredDescription') }}</p>
          <ul class="space-y-2">
            <li
              v-for="r in retired"
              :key="r.pipeline.id"
              class="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3"
            >
              <div class="min-w-0">
                <span class="truncate text-sm font-medium text-slate-100">{{
                  r.pipeline.name
                }}</span>
                <p class="text-[11px] text-slate-400/80">
                  {{
                    r.replacement
                      ? t('pipeline.health.retiredReplacedBy', { name: r.replacement.name })
                      : t('pipeline.health.retiredNote')
                  }}
                </p>
              </div>
              <UButton
                size="xs"
                color="error"
                variant="subtle"
                icon="i-lucide-trash-2"
                :loading="isBusy(r.pipeline.id)"
                :disabled="locked"
                @click="removeRetired(r.pipeline)"
              >
                {{ t('pipeline.health.remove') }}
              </UButton>
            </li>
          </ul>
        </section>

        <!-- Outdated built-ins: a newer catalog version is available. -->
        <section v-if="outdated.length" class="space-y-2">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-arrow-up-circle" class="h-4 w-4 text-amber-400" />
            <h3 class="text-sm font-semibold text-slate-200">
              {{ t('pipeline.health.updatesHeading') }}
            </h3>
          </div>
          <p class="text-[11px] text-slate-500">
            {{ t('pipeline.health.updatesDescription') }}
          </p>
          <ul class="space-y-2">
            <li
              v-for="h in outdated"
              :key="h.pipeline.id"
              class="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3"
            >
              <div class="min-w-0">
                <span class="truncate text-sm font-medium text-slate-100">{{
                  h.pipeline.name
                }}</span>
                <p class="text-[11px] text-amber-400/80">{{ h.problems[0]?.message }}</p>
              </div>
              <UButton
                size="xs"
                color="primary"
                variant="subtle"
                icon="i-lucide-rotate-ccw"
                :loading="isBusy(h.pipeline.id)"
                :disabled="locked"
                @click="reseed(h.pipeline.id)"
              >
                {{ t('pipeline.health.reseed') }}
              </UButton>
            </li>
          </ul>
        </section>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton
          v-if="reseedableCount > 1"
          color="primary"
          variant="ghost"
          icon="i-lucide-rotate-ccw"
          :loading="anyBusy"
          :disabled="locked"
          @click="reseedAll"
        >
          {{ t('pipeline.health.reseedAll', { count: reseedableCount }) }}
        </UButton>
        <span v-else />
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="locked"
          @click="ui.closePipelineHealth()"
        >
          {{ hasIssues ? t('pipeline.health.dismiss') : t('pipeline.health.done') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
