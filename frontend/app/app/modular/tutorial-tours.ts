import { defineModule } from '@modular-vue/core'
import type { TutorialTour } from '~/utils/tutorial'

/**
 * The first-party tutorial-tour catalog, contributed to the `tutorialTours` slot the same
 * way the nav catalog fills `nav`: declared ONCE as data, rendered by one shared runtime
 * (`TutorialOverlay`), and open to consumer deployments — `registerAppModule` a module
 * with its own `tutorialTours` entries and they appear in the launch prompt beside these.
 *
 * Authoring rules (what keeps a tour evolvable as the app changes):
 *
 *  - A step points at a control by its `data-testid` — the same stable anchor vocabulary
 *    the e2e suite owns. Covering a control that has none means adding the test id first
 *    (a behaviour-neutral change), never inventing a parallel attribute.
 *  - A missing anchor SKIPS the step rather than stranding the tour: controls come and go
 *    with RBAC, interface tier, and deployment wiring, so a tour must be a set of
 *    opportunities, not a fixed script. Gate a whole tour on `when` only when its SUBJECT
 *    requires it (e.g. board-write for a tour that creates a task).
 *  - "Now click this" steps use `advanceOn: 'target-click'` so the user drives the real
 *    control and the app's real response (the actual modal, the actual task) is what the
 *    next step anchors to. Steps whose anchor only exists after that response give it a
 *    longer `waitForTargetMs`.
 *  - Copy lives under `tutorial.tours.<tourCamelId>.steps.<stepId>` in the i18n catalogs;
 *    tours never carry display strings.
 */
export const TUTORIAL_TOURS: readonly TutorialTour[] = [
  {
    id: 'board-basics',
    order: 10,
    icon: 'i-lucide-map',
    titleKey: 'tutorial.tours.boardBasics.title',
    descriptionKey: 'tutorial.tours.boardBasics.description',
    steps: [
      {
        id: 'welcome',
        titleKey: 'tutorial.tours.boardBasics.steps.welcome.title',
        bodyKey: 'tutorial.tours.boardBasics.steps.welcome.body',
      },
      {
        id: 'canvas',
        target: 'board-canvas',
        placement: 'right',
        titleKey: 'tutorial.tours.boardBasics.steps.canvas.title',
        bodyKey: 'tutorial.tours.boardBasics.steps.canvas.body',
      },
      {
        id: 'sidebar',
        target: 'sidebar',
        placement: 'right',
        titleKey: 'tutorial.tours.boardBasics.steps.sidebar.title',
        bodyKey: 'tutorial.tours.boardBasics.steps.sidebar.body',
      },
      {
        id: 'commandBar',
        target: 'command-bar-launcher',
        placement: 'right',
        titleKey: 'tutorial.tours.boardBasics.steps.commandBar.title',
        bodyKey: 'tutorial.tours.boardBasics.steps.commandBar.body',
      },
      {
        id: 'toolbar',
        target: 'board-fit-view',
        placement: 'bottom',
        titleKey: 'tutorial.tours.boardBasics.steps.toolbar.title',
        bodyKey: 'tutorial.tours.boardBasics.steps.toolbar.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.boardBasics.steps.finish.title',
        bodyKey: 'tutorial.tours.boardBasics.steps.finish.body',
      },
    ],
  },
  {
    id: 'first-task',
    order: 20,
    icon: 'i-lucide-list-plus',
    titleKey: 'tutorial.tours.firstTask.title',
    descriptionKey: 'tutorial.tours.firstTask.description',
    // Creating a task is a board WRITE; a viewer has no add-task button to point at.
    when: (gates) => gates.canWriteBoard,
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.firstTask.steps.intro.title',
        bodyKey: 'tutorial.tours.firstTask.steps.intro.body',
      },
      {
        id: 'addTask',
        target: 'frame-add-task',
        // An empty frame renders its add-task affordance as a full-width button instead.
        altTargets: ['frame-add-task-empty'],
        advanceOn: 'target-click',
        placement: 'bottom',
        titleKey: 'tutorial.tours.firstTask.steps.addTask.title',
        bodyKey: 'tutorial.tours.firstTask.steps.addTask.body',
      },
      {
        id: 'describe',
        target: 'add-task-title',
        advanceOn: 'target-click',
        placement: 'right',
        // The anchor lives inside the modal the previous click opens; allow it to mount.
        waitForTargetMs: 8000,
        titleKey: 'tutorial.tours.firstTask.steps.describe.title',
        bodyKey: 'tutorial.tours.firstTask.steps.describe.body',
      },
      {
        id: 'create',
        target: 'add-task-submit',
        advanceOn: 'target-click',
        placement: 'top',
        titleKey: 'tutorial.tours.firstTask.steps.create.title',
        bodyKey: 'tutorial.tours.firstTask.steps.create.body',
      },
      {
        id: 'card',
        target: 'task-card',
        placement: 'bottom',
        // The card arrives over the live event stream after the create round-trips.
        waitForTargetMs: 10000,
        titleKey: 'tutorial.tours.firstTask.steps.card.title',
        bodyKey: 'tutorial.tours.firstTask.steps.card.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.firstTask.steps.finish.title',
        bodyKey: 'tutorial.tours.firstTask.steps.finish.body',
      },
    ],
  },
]

/** The module that contributes the catalog; registered by `createAppRegistry`. */
export const tutorialToursModule = defineModule({
  id: 'cat-factory:tutorial-tours',
  version: '1.0.0',
  slots: { tutorialTours: [...TUTORIAL_TOURS] },
})
