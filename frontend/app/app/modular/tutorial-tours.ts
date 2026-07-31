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
 *    tours never carry display strings. The exception is a fixed proper noun such as
 *    {@link SAMPLE_REPO}, which rides `bodyParams` so it is written once here rather than
 *    translated ten times.
 *  - A step whose branch of the flow this board simply isn't on declares `when`, so it is
 *    DROPPED rather than skipped: a skip is reported as an abridged tour, and a parked run
 *    that has a decision and no approval gate is not an abridged anything.
 *
 * Together the tours below walk the delivery loop end to end — get a repo onto the board,
 * put a task on it, run it, answer it when it asks, read the result and merge it — with each
 * later tour gated on the state the previous one produces, so the launch prompt only ever
 * offers what this board can actually demonstrate.
 */

/**
 * The practice project the tours point at: a deliberately small Hono service, kept
 * unfinished on purpose so there is always a real task to hand an agent.
 *
 * Named in code rather than in `en.json` because it is a repository slug: it must not be
 * translated, and nine other catalogs would each hold their own copy of it to drift.
 */
export const SAMPLE_REPO = 'kibertoad/cat-factory-sample-repository'

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
        // Basic mode is the shipped default, and it HIDES a whole half of the product
        // (sandbox, Kaizen, bootstrap, the operator surfaces). A user who never finds the
        // switcher never learns that half exists, so the orientation tour is the one place
        // that has to name it — the switcher is deliberately visible in both tiers for the
        // same reason (see `nav-contributions.ts`).
        id: 'interfaceTier',
        target: 'ui-mode-switcher',
        altTargets: ['ui-mode-toggle'],
        placement: 'right',
        titleKey: 'tutorial.tours.boardBasics.steps.interfaceTier.title',
        bodyKey: 'tutorial.tours.boardBasics.steps.interfaceTier.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.boardBasics.steps.finish.title',
        bodyKey: 'tutorial.tours.boardBasics.steps.finish.body',
      },
    ],
  },
  {
    id: 'add-service',
    order: 15,
    icon: 'i-lucide-folder-git-2',
    titleKey: 'tutorial.tours.addService.title',
    descriptionKey: 'tutorial.tours.addService.description',
    // The tour that unblocks every later one: `first-task` needs a service frame to add a
    // task to, and until one exists a new workspace is offered `board-basics` and nothing
    // else — an orientation tour of an empty canvas ending on "you're all set". Linking a
    // repo is a board write against a connected source, and in basic interface mode
    // add-from-repo is the ONLY route (bootstrap is advanced), which is what makes this
    // worth a tour rather than a hint.
    when: (gates) => gates.canWriteBoard && gates.githubAvailable,
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.addService.steps.intro.title',
        bodyKey: 'tutorial.tours.addService.steps.intro.body',
      },
      {
        id: 'open',
        target: 'nav-add-from-repo',
        advanceOn: 'target-click',
        placement: 'right',
        titleKey: 'tutorial.tours.addService.steps.open.title',
        bodyKey: 'tutorial.tours.addService.steps.open.body',
      },
      {
        id: 'search',
        target: 'add-service-repo-search',
        // Inside the modal the previous click opens.
        waitForTargetMs: 8000,
        placement: 'bottom',
        titleKey: 'tutorial.tours.addService.steps.search.title',
        bodyKey: 'tutorial.tours.addService.steps.search.body',
        // The sample repo is a suggestion, not an instruction: the picker lists what this
        // workspace's installation can see, and someone practising on their own repo is
        // doing the right thing too. The copy says as much — a step that told them to pick
        // a repo they may not have would strand them at exactly this anchor.
        bodyParams: { repo: SAMPLE_REPO },
      },
      {
        id: 'add',
        target: 'add-service-submit',
        advanceOn: 'target-click',
        placement: 'top',
        titleKey: 'tutorial.tours.addService.steps.add.title',
        bodyKey: 'tutorial.tours.addService.steps.add.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.addService.steps.finish.title',
        bodyKey: 'tutorial.tours.addService.steps.finish.body',
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
    // It also needs somewhere to PUT the task: on a board with no service frame every
    // targeted step below would time out in turn, so the tour would spend half a minute
    // hunting for controls and then claim to have taught the core loop. Offering it only
    // once a service exists is the honest version — and the launch prompt still lists
    // `board-basics`, which is the tour an empty board can actually deliver.
    when: (gates) => gates.canWriteBoard && gates.boardHasService,
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
        // Deliberately NOT `target-click`: clicking a text field is how you START typing,
        // so click-to-advance would move the tooltip off the instruction the moment the
        // user acted on it. The user reads, types, and presses Next when they are ready;
        // `target-click` is for buttons, where the click IS the completed action.
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
  {
    id: 'run-task',
    order: 30,
    icon: 'i-lucide-play',
    titleKey: 'tutorial.tours.runTask.title',
    descriptionKey: 'tutorial.tours.runTask.description',
    // Everything that MAKES this a delivery platform lives one click inside a task: the
    // pipeline it will run, the start control, the live step list. `first-task` stops at the
    // card, so without this tour a user who finished the shipped walkthrough has never seen
    // the inspector. Needs a task to open, not merely a service to hold one.
    when: (gates) => gates.canWriteBoard && gates.boardHasTask,
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.runTask.steps.intro.title',
        bodyKey: 'tutorial.tours.runTask.steps.intro.body',
      },
      {
        id: 'openTask',
        target: 'task-card',
        advanceOn: 'target-click',
        placement: 'right',
        titleKey: 'tutorial.tours.runTask.steps.openTask.title',
        bodyKey: 'tutorial.tours.runTask.steps.openTask.body',
      },
      {
        id: 'inspector',
        target: 'inspector-panel',
        waitForTargetMs: 8000,
        placement: 'left',
        titleKey: 'tutorial.tours.runTask.steps.inspector.title',
        bodyKey: 'tutorial.tours.runTask.steps.inspector.body',
      },
      {
        id: 'pipeline',
        target: 'pipeline-picker-trigger',
        placement: 'left',
        titleKey: 'tutorial.tours.runTask.steps.pipeline.title',
        bodyKey: 'tutorial.tours.runTask.steps.pipeline.body',
      },
      {
        // Deliberately NOT `target-click`, unlike every other "here is the button" step in
        // the catalog: starting a run spends the workspace's model budget for real. The
        // tour points the control out and hands the decision back, so nobody discovers they
        // agreed to a paid run by following a tutorial.
        id: 'start',
        target: 'run-start',
        placement: 'left',
        titleKey: 'tutorial.tours.runTask.steps.start.title',
        bodyKey: 'tutorial.tours.runTask.steps.start.body',
      },
      {
        // The anatomy of a run in flight. Dropped on a board that has never run anything —
        // there is no step list to point at, and that is a state, not an omission.
        id: 'steps',
        target: 'run-step',
        when: (gates) => gates.boardHasRun,
        waitForTargetMs: 6000,
        placement: 'left',
        titleKey: 'tutorial.tours.runTask.steps.steps.title',
        bodyKey: 'tutorial.tours.runTask.steps.steps.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.runTask.steps.finish.title',
        bodyKey: 'tutorial.tours.runTask.steps.finish.body',
      },
    ],
  },
  {
    id: 'answer-park',
    order: 40,
    icon: 'i-lucide-circle-help',
    titleKey: 'tutorial.tours.answerPark.title',
    descriptionKey: 'tutorial.tours.answerPark.description',
    // The one gap with a standing cost attached: a parked run waits for a human
    // INDEFINITELY by design (there is deliberately no park timeout), so a user who does not
    // realise a run is asking them something has a run that never finishes and a workspace
    // in-flight slot held open. Offered only while something is actually waiting, because
    // the whole tour anchors on controls that exist only then.
    when: (gates) => gates.boardHasOpenDecision || gates.boardHasPendingApproval,
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.answerPark.steps.intro.title',
        bodyKey: 'tutorial.tours.answerPark.steps.intro.body',
      },
      {
        // The card's own attention action, which resolves to whichever surface this park
        // needs — one anchor for both branches, rather than a decision route and an approval
        // route the tour would have to choose between before the user has clicked anything.
        id: 'resolve',
        target: 'task-resolve',
        advanceOn: 'target-click',
        placement: 'right',
        titleKey: 'tutorial.tours.answerPark.steps.resolve.title',
        bodyKey: 'tutorial.tours.answerPark.steps.resolve.body',
      },
      {
        id: 'decide',
        target: 'decision-option',
        when: (gates) => gates.boardHasOpenDecision,
        waitForTargetMs: 8000,
        placement: 'top',
        titleKey: 'tutorial.tours.answerPark.steps.decide.title',
        bodyKey: 'tutorial.tours.answerPark.steps.decide.body',
      },
      {
        // Mirrors the card's own precedence (`TaskCard.attention` prefers a decision when a
        // block has both), so this branch is included exactly when the click above will
        // really land on an approval — not merely when an approval exists somewhere.
        id: 'approve',
        target: 'step-approve',
        when: (gates) => gates.boardHasPendingApproval && !gates.boardHasOpenDecision,
        waitForTargetMs: 8000,
        placement: 'top',
        titleKey: 'tutorial.tours.answerPark.steps.approve.title',
        bodyKey: 'tutorial.tours.answerPark.steps.approve.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.answerPark.steps.finish.title',
        bodyKey: 'tutorial.tours.answerPark.steps.finish.body',
      },
    ],
  },
  {
    id: 'review-merge',
    order: 50,
    icon: 'i-lucide-git-merge',
    titleKey: 'tutorial.tours.reviewMerge.title',
    descriptionKey: 'tutorial.tours.reviewMerge.description',
    // The last mile: a task is only DONE when its PR actually merged, so a user who never
    // finds the result and the merge control has a board full of finished-looking work that
    // shipped nothing. Its subject is a run's output, so it needs a run that produced one.
    when: (gates) => gates.boardHasFinishedRun,
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.reviewMerge.steps.intro.title',
        bodyKey: 'tutorial.tours.reviewMerge.steps.intro.body',
      },
      {
        id: 'openTask',
        target: 'task-card',
        advanceOn: 'target-click',
        placement: 'right',
        titleKey: 'tutorial.tours.reviewMerge.steps.openTask.title',
        bodyKey: 'tutorial.tours.reviewMerge.steps.openTask.body',
      },
      {
        id: 'openStep',
        target: 'run-step',
        advanceOn: 'target-click',
        waitForTargetMs: 8000,
        placement: 'left',
        titleKey: 'tutorial.tours.reviewMerge.steps.openStep.title',
        bodyKey: 'tutorial.tours.reviewMerge.steps.openStep.body',
      },
      {
        id: 'result',
        target: 'step-detail',
        waitForTargetMs: 8000,
        placement: 'left',
        titleKey: 'tutorial.tours.reviewMerge.steps.result.title',
        bodyKey: 'tutorial.tours.reviewMerge.steps.result.body',
      },
      {
        // Left to the anchor-skip rather than given a `when`: a finished run whose pipeline
        // opened no PR genuinely has no merge control, which is what a skip MEANS. Gating it
        // would need a "this block has an open PR" gate that nothing else wants.
        id: 'merge',
        target: 'inspector-merge-pr',
        waitForTargetMs: 6000,
        placement: 'left',
        titleKey: 'tutorial.tours.reviewMerge.steps.merge.title',
        bodyKey: 'tutorial.tours.reviewMerge.steps.merge.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.reviewMerge.steps.finish.title',
        bodyKey: 'tutorial.tours.reviewMerge.steps.finish.body',
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
