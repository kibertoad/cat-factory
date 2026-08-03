<script setup lang="ts">
// The tutorial launch prompt: asks once on first launch whether the user wants a guided
// tour, and doubles as the tour picker for later visits (command palette: "Take a tour").
// Lists whatever the merged `tutorialTours` slot offers this user (first-party + consumer
// tours, RBAC-gated per tour), so it grows with the catalog rather than hard-coding tours.
//
// The decision semantics live in the store: starting a tour or "No thanks" is SAVED (the
// prompt never auto-opens again), while closing without answering defers to next launch.
const { t } = useI18n()
const tutorial = useTutorialStore()
const { tours } = useTutorialTours()

const open = computed({
  get: () => tutorial.promptOpen,
  set: (v: boolean) => (v ? tutorial.openPrompt() : tutorial.closePrompt()),
})

// Only an unanswered prompt offers the persistent "No thanks"; once a decision exists this
// is just a picker, and the only dismissal left is a plain close.
const undecided = computed(() => tutorial.decision === null)

// A tour broken off mid-way (Esc, or Skip to get the overlay out of the way) offers to RESUME
// where it stopped rather than only to start over. Session-scoped, so this is only ever offered
// while the board is still in the state the tour left it in — see the store.
const isResumable = (tourId: string) => tutorial.interruptedAt(tourId) !== null

function launch(tourId: string) {
  if (isResumable(tourId)) tutorial.resumeTour(tourId)
  else tutorial.startTour(tourId)
}

/** Resume beats Completed: a tour taken again and broken off is offered where it stopped. */
function launchLabel(tourId: string): string {
  if (isResumable(tourId)) return t('tutorial.prompt.resume')
  return tutorial.isCompleted(tourId) ? t('tutorial.prompt.restart') : t('tutorial.prompt.start')
}
</script>

<template>
  <UModal v-model:open="open" :title="t('tutorial.prompt.title')" :ui="{ content: 'max-w-lg' }">
    <template #body>
      <!-- NOTE for spec authors: this marks the modal's BODY, so it is the "prompt is
           showing" signal, not a container for everything in the prompt. The footer's
           decline/close buttons are in a SIBLING slot — address them from the page by
           their own test ids rather than scoping a locator under this one. -->
      <div class="space-y-4" data-testid="tutorial-prompt">
        <p class="text-sm text-slate-300">{{ t('tutorial.prompt.intro') }}</p>
        <ul class="space-y-2">
          <li
            v-for="tour in tours"
            :key="tour.id"
            class="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3"
          >
            <UIcon
              :name="tour.icon ?? 'i-lucide-compass'"
              class="h-5 w-5 shrink-0 text-primary-400"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-slate-100">{{ t(tour.titleKey) }}</span>
                <UBadge
                  v-if="tutorial.isCompleted(tour.id)"
                  color="success"
                  variant="subtle"
                  size="sm"
                  data-testid="tutorial-tour-completed"
                >
                  {{ t('tutorial.prompt.completed') }}
                </UBadge>
              </div>
              <p class="text-xs text-slate-400">{{ t(tour.descriptionKey) }}</p>
            </div>
            <UButton
              size="sm"
              color="primary"
              :variant="tutorial.isCompleted(tour.id) && !isResumable(tour.id) ? 'soft' : 'solid'"
              :data-testid="`tutorial-start-${tour.id}`"
              @click="launch(tour.id)"
            >
              {{ launchLabel(tour.id) }}
            </UButton>
          </li>
        </ul>
        <!-- Every tour gated away (e.g. a viewer on a write-only catalog): say so rather
             than showing an unexplained empty list. -->
        <p v-if="tours.length === 0" class="text-sm text-slate-400">
          {{ t('tutorial.prompt.empty') }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton
          v-if="undecided"
          color="neutral"
          variant="ghost"
          data-testid="tutorial-decline"
          @click="tutorial.decline()"
        >
          {{ t('tutorial.prompt.decline') }}
        </UButton>
        <span v-else />
        <UButton
          color="neutral"
          variant="soft"
          data-testid="tutorial-close"
          @click="tutorial.closePrompt()"
        >
          {{ undecided ? t('tutorial.prompt.later') : t('common.close') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
