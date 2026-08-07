<script setup lang="ts">
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'
import FragmentSelector from '~/components/fragments/FragmentSelector.vue'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const fragments = useFragmentsStore()
const toast = useToast()
const { t } = useI18n()

// ---- module assignment -----------------------------------------------------
// This is the module-assignment route that does NOT depend on how the board is currently
// grouped. Dragging a card onto a module's group header works only while the reader has
// grouping set to `module`, and module sub-frames no longer render as boxes to drop onto, so
// without this the only way to move a task into a module would be to first change a view
// preference. It writes the same two things a drag does: the declared `moduleName` and, when the
// module block already exists, the structural parent.
//
// The field used to be a free-text `UInput` bound with `v-model="block.moduleName"`, which
// mutated the cached store object and never called `updateBlock` — so a module typed here was
// silently discarded on the next board refresh. Now that module grouping is a first-class board
// affordance, a field that looks like it assigns a module and does not would read as the grouping
// being broken.
const service = computed(() => board.serviceOf(props.block))

/** The modules the enclosing service has materialised, as picker options. */
const moduleOptions = computed(() => {
  const frame = service.value
  const existing = frame ? board.modulesOf(frame.id).map((m) => m.title) : []
  // A task can DECLARE a module the engine has not created a block for yet (it materialises one
  // on merge), so the task's own value has to be offerable even when no block carries that name,
  // or opening the picker would silently drop it.
  const own = props.block.moduleName?.trim()
  const names = own && !existing.includes(own) ? [...existing, own] : existing
  return [
    { label: t('inspector.structure.moduleNone'), value: '' },
    ...names.map((n) => ({ label: n, value: n })),
  ]
})

const selectedModule = computed(() => props.block.moduleName?.trim() ?? '')

async function setModule(name: string) {
  const previous = selectedModule.value
  if (name === previous) return
  try {
    // The declared module is what the engine reads when it materialises the module block on
    // merge, so it is written first and is authoritative. "No module" sends the EMPTY STRING,
    // which is how `updateBlock` spells a clear: `undefined` is dropped by `JSON.stringify`, so
    // it reached the server as an empty patch and the response then restored the old value.
    await board.updateBlock(props.block.id, { moduleName: name })

    // When a block for that module already exists, move the task under it now rather than waiting
    // for a merge, so the board's grouping matches what was just chosen.
    const frame = service.value
    const target = frame
      ? name
        ? board.modulesOf(frame.id).find((m) => m.title === name)
        : frame
      : undefined
    if (target && target.id !== props.block.parentId) {
      await board.reparentBlock(props.block.id, target.id, { x: 0, y: 0 })
    }
  } catch {
    // `updateBlock`/`reparentBlock` already roll back and toast their own failures; this catch
    // exists so a rejected reparent cannot leave the await chain unhandled.
    // silent-catch-ok: both mutations report their own failure to the user.
  }
}

// ---- best-practice prompt fragments ----------------------------------------
// The task's OWN selection (seeded from its service at creation, then editable per task). The
// shared <FragmentSelector> renders the picker; a change persists via updateBlock.
const fragmentPool = computed(() => fragments.forBlockType(props.block.type))
function setFragments(ids: string[]) {
  board.updateBlock(props.block.id, { fragmentIds: ids })
}
</script>

<template>
  <InspectorSection :title="t('inspector.structure.title')" :hint="t('inspector.structure.hint')">
    <!-- module assignment -->
    <div>
      <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('inspector.structure.module') }}
      </div>
      <USelectMenu
        :model-value="selectedModule"
        :items="moduleOptions"
        value-key="value"
        size="sm"
        class="w-full"
        icon="i-lucide-package"
        :create-item="true"
        :placeholder="t('inspector.structure.modulePlaceholder')"
        data-testid="task-module-select"
        @update:model-value="setModule"
        @create="setModule"
      />
      <p class="mt-1 text-[11px] leading-snug text-slate-500">
        {{ t('inspector.structure.moduleHint') }}
      </p>
    </div>

    <!-- best practices (prompt fragments) -->
    <div>
      <FragmentSelector
        :model-value="block.fragmentIds ?? []"
        :pool="fragmentPool"
        :label="t('inspector.structure.bestPractices')"
        :empty-text="t('inspector.structure.bestPracticesEmpty')"
        @update:model-value="setFragments"
      />
      <p class="mt-1 text-[11px] leading-snug text-slate-500">
        {{ t('inspector.structure.bestPracticesHint') }}
      </p>
    </div>
  </InspectorSection>
</template>
