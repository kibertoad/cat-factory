<script setup lang="ts">
// The tutorial launch prompt: asks once on first launch whether the user wants a guided tour,
// listing the first-run tours this board can actually run right now (first-party + consumer,
// resolved against the same gates the nav uses), so it grows with the catalog rather than
// hard-coding tours.
//
// It is the OFFER, not the library: the full list — the platform walkthroughs that are kept out
// of this question (`offeredAtLaunch: false`), plus the ones this board can't run yet and what
// would unlock them — is `TutorialCatalogue.vue`, one button away in the footer and permanently
// reachable from the sidebar's Help section. That split is why this stays a short, answerable
// question instead of growing into a browsing surface, and why it reads `offered` rather than
// every startable tour.
//
// The decision semantics live in the store: starting a tour or "No thanks" is SAVED (the
// prompt never auto-opens again), while closing without answering defers to next launch.
import { TUTORIAL_ACTION_KEYS } from '~/utils/tutorial'

const { t } = useI18n()
const tutorial = useTutorialStore()
const { offered } = useTutorialTours()
// Start / Resume / Repeat is decided in one place for both surfaces — see `useTutorialLaunch`.
const { actionFor, launch } = useTutorialLaunch()

const open = computed({
  get: () => tutorial.promptOpen,
  set: (v: boolean) => (v ? tutorial.openPrompt() : tutorial.closePrompt()),
})

// Only an unanswered prompt offers the persistent "No thanks": there is a decision to save.
// Once one exists — this window can still be opened by the store — the only dismissal left is
// a plain close, since declining something already answered would write nothing new.
const undecided = computed(() => tutorial.decision === null)
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
            v-for="tour in offered"
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
                  {{ t('tutorial.status.completed') }}
                </UBadge>
              </div>
              <p class="text-xs text-slate-400">{{ t(tour.descriptionKey) }}</p>
            </div>
            <UButton
              size="sm"
              color="primary"
              :variant="actionFor(tour.id) === 'restart' ? 'soft' : 'solid'"
              :data-testid="`tutorial-start-${tour.id}`"
              @click="launch(tour.id)"
            >
              {{ t(TUTORIAL_ACTION_KEYS[actionFor(tour.id)]) }}
            </UButton>
          </li>
        </ul>
        <!-- Every first-run tour gated away (e.g. a viewer on a write-only catalog): say so
             rather than showing an unexplained empty list. The footer's browse button stays,
             because the catalogue may well hold something this user can take. -->
        <p v-if="offered.length === 0" class="text-sm text-slate-400">
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
        <div class="flex items-center gap-2">
          <!-- The way to the tours this board can't run yet, and to the ones already taken.
               Browsing answers nothing, so it neither declines the offer nor accepts it. -->
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-graduation-cap"
            data-testid="tutorial-browse"
            @click="tutorial.openCatalogue()"
          >
            {{ t('tutorial.prompt.browse') }}
          </UButton>
          <UButton
            color="neutral"
            variant="soft"
            data-testid="tutorial-close"
            @click="tutorial.closePrompt()"
          >
            {{ undecided ? t('tutorial.prompt.later') : t('common.close') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
