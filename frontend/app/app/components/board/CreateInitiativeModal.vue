<script setup lang="ts">
// Create a new INITIATIVE under a service frame — the longer-running counterpart
// to a task. The user names it and writes the rough goal statement; the server
// materialises the initiative-level board block + its empty tracker entity in one
// call. Nothing is planned here: the user then runs the Initiative Planning
// pipeline (pl_initiative) on the block, which analyses the codebase, drafts the
// multi-phase plan for approval, and commits the in-repo tracker.
const ui = useUiStore()
const board = useBoardStore()
const initiatives = useInitiativesStore()
const toast = useToast()
const { t } = useI18n()

const open = computed({
  get: () => ui.createInitiativeFrameId !== null,
  set: (v: boolean) => {
    if (!v) ui.closeCreateInitiative()
  },
})

const frame = computed(() =>
  ui.createInitiativeFrameId ? board.getBlock(ui.createInitiativeFrameId) : undefined,
)

const title = ref('')
const description = ref('')

watch(open, (o) => {
  if (o) {
    title.value = ''
    description.value = ''
  }
})

async function create() {
  const frameId = ui.createInitiativeFrameId
  if (!frameId || !title.value.trim() || initiatives.creating) return
  try {
    const { block } = await initiatives.create(frameId, {
      title: title.value.trim(),
      description: description.value.trim() || undefined,
    })
    ui.closeCreateInitiative()
    // Select the fresh block so the inspector offers "Run planning" right away.
    ui.select(block.id)
  } catch (e) {
    toast.add({
      title: t('initiative.create.failedTitle'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="t('initiative.create.title')">
    <template #body>
      <div class="space-y-4" data-testid="create-initiative-modal">
        <p v-if="frame" class="text-xs text-slate-400">
          <i18n-t keypath="initiative.create.inFrame" tag="span" scope="global">
            <template #frame>
              <span class="font-medium text-slate-200">{{ frame.title }}</span>
            </template>
          </i18n-t>
        </p>

        <UFormField :label="t('initiative.create.titleField')" required>
          <UInput
            v-model="title"
            data-testid="create-initiative-title"
            :placeholder="t('initiative.create.titlePlaceholder')"
            autofocus
            class="w-full"
            @keydown.enter="create"
          />
        </UFormField>

        <UFormField :label="t('initiative.create.goalField')">
          <UTextarea
            v-model="description"
            data-testid="create-initiative-goal"
            :rows="4"
            autoresize
            :placeholder="t('initiative.create.goalPlaceholder')"
            class="w-full"
          />
        </UFormField>

        <p class="text-[11px] text-slate-500">
          {{ t('initiative.create.hint') }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          @click="
            () => {
              open = false
            }
          "
        >
          {{ t('common.cancel') }}
        </UButton>
        <UButton
          data-testid="create-initiative-submit"
          color="primary"
          :loading="initiatives.creating"
          :disabled="!title.trim()"
          @click="create"
        >
          {{ t('initiative.create.submit') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
