<script setup lang="ts">
// The tutorial catalogue: every guided walkthrough this deployment ships, startable (or
// re-startable) at any time from the sidebar's Help section and the command palette.
//
// It is deliberately NOT the launch prompt with a second entry point. The prompt asks a
// question once, offers what this board can run, and goes away; this answers "what else is
// there, and why can't I take that one yet?" — so it lists the tours that are HELD BACK too,
// each with the requirement still missing. Omitting them (which is all a slot filter could do)
// makes a deployment shipping six walkthroughs look like one shipping two.
//
// Everything that decides lives in `TutorialCatalogue.logic.ts` (rows, progress) and
// `utils/tutorial.ts` (availability, state, action), so the SFC only renders.
import { buildCatalogueRows, summarizeProgress } from './TutorialCatalogue.logic'
import type { TutorialCatalogueRow } from './TutorialCatalogue.logic'
import { TUTORIAL_ACTION_KEYS, TUTORIAL_STATUS_KEYS } from '~/utils/tutorial'

const { t } = useI18n()
const tutorial = useTutorialStore()
const { catalogue } = useTutorialTours()
const { stateOf, launch } = useTutorialLaunch()
const { resetServerProgress } = useTutorialServer()

/**
 * Forget everything, on BOTH sides. The local clear alone would be undone by the next board load:
 * the snapshot brings the server row back and the store MERGES it, which is exactly right for every
 * other reconciliation and exactly wrong for the one action whose whole point is to erase the
 * record. `useTutorialServer` rather than `useTutorialSync` because this must not install a second
 * set of mirror watchers each time the catalogue mounts.
 */
function reset() {
  tutorial.resetProgress()
  resetServerProgress()
}

const open = computed({
  get: () => tutorial.catalogueOpen,
  set: (v: boolean) => (v ? tutorial.openCatalogue() : tutorial.closeCatalogue()),
})

const rows = computed(() => buildCatalogueRows(catalogue.value, stateOf))
const progress = computed(() =>
  summarizeProgress(rows.value, { launchOfferAnswered: tutorial.decision !== null }),
)

/** A badge only where there is something to say: "not started" is the unremarkable default. */
const showsStatus = (row: TutorialCatalogueRow) => row.state !== 'notStarted'

const statusColor = (row: TutorialCatalogueRow) =>
  row.state === 'completed' ? 'success' : row.state === 'inProgress' ? 'primary' : 'neutral'
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('tutorial.catalogue.title')"
    :description="t('tutorial.catalogue.intro')"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4" data-testid="tutorial-catalogue">
        <p v-if="rows.length > 0" class="text-xs text-slate-400" data-testid="tutorial-progress">
          {{
            t('tutorial.catalogue.progress', {
              completed: progress.completed,
              total: progress.total,
            })
          }}
        </p>
        <ul class="space-y-2">
          <li
            v-for="row in rows"
            :key="row.tour.id"
            class="flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3"
            :class="row.startable ? '' : 'opacity-75'"
            :data-testid="`tutorial-catalogue-entry-${row.tour.id}`"
          >
            <UIcon
              :name="row.tour.icon ?? 'i-lucide-compass'"
              class="mt-0.5 h-5 w-5 shrink-0 text-primary-400"
            />
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-medium text-slate-100">{{ t(row.tour.titleKey) }}</span>
                <UBadge
                  v-if="showsStatus(row)"
                  :color="statusColor(row)"
                  variant="subtle"
                  size="sm"
                  :data-testid="`tutorial-catalogue-status-${row.tour.id}`"
                >
                  {{ t(TUTORIAL_STATUS_KEYS[row.state]) }}
                </UBadge>
              </div>
              <p class="text-xs text-slate-400">{{ t(row.tour.descriptionKey) }}</p>
              <p v-if="row.stepCount !== null" class="text-xs text-slate-500">
                {{ t('tutorial.catalogue.steps', { count: row.stepCount }, row.stepCount) }}
              </p>
              <!-- A held-back tour says what would unlock it, rather than vanishing from the
                   list: these are things the reader can go and do. -->
              <div
                v-else-if="row.availability === 'blocked'"
                class="text-xs text-slate-500"
                :data-testid="`tutorial-catalogue-requirements-${row.tour.id}`"
              >
                <span>{{ t('tutorial.catalogue.blocked') }}</span>
                <ul class="mt-1 space-y-0.5">
                  <li v-for="req in row.unmet" :key="req.id" class="flex items-center gap-1.5">
                    <UIcon name="i-lucide-lock" class="h-3 w-3 shrink-0" />
                    <span>{{ t(req.labelKey) }}</span>
                  </li>
                </ul>
              </div>
              <!-- Requirements met, but every step is about a branch this board isn't on:
                   nothing to go and fix, so it must not read like the case above. -->
              <p v-else class="text-xs text-slate-500">
                {{ t('tutorial.catalogue.notApplicable') }}
              </p>
            </div>
            <UButton
              size="sm"
              color="primary"
              :variant="row.state === 'completed' ? 'soft' : 'solid'"
              :disabled="!row.startable"
              :data-testid="`tutorial-catalogue-start-${row.tour.id}`"
              @click="launch(row.tour.id)"
            >
              {{ t(TUTORIAL_ACTION_KEYS[row.action]) }}
            </UButton>
          </li>
        </ul>
        <!-- No tours at all is a real state (a deployment may register none of its own and
             strip the built-ins), and it is not the same as one whose tours are all blocked. -->
        <p v-if="rows.length === 0" class="text-sm text-slate-400">
          {{ t('tutorial.catalogue.empty') }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton
          v-if="progress.resettable"
          color="neutral"
          variant="ghost"
          icon="i-lucide-rotate-ccw"
          :title="t('tutorial.catalogue.resetHint')"
          data-testid="tutorial-catalogue-reset"
          @click="reset()"
        >
          {{ t('tutorial.catalogue.reset') }}
        </UButton>
        <span v-else />
        <UButton
          color="neutral"
          variant="soft"
          data-testid="tutorial-catalogue-close"
          @click="tutorial.closeCatalogue()"
        >
          {{ t('common.close') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
