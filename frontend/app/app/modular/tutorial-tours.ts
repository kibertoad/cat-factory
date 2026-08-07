import { defineModule } from '@modular-vue/core'
import type { TutorialRequirement, TutorialTour } from '~/utils/tutorial'

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
 *  - A tour's own preconditions are DECLARED ({@link TUTORIAL_REQUIREMENTS}), never an
 *    anonymous predicate: the catalogue lists every tour this deployment ships and has to say
 *    what a user must do before one it is holding back becomes available.
 *
 * The catalog is in two halves, and the split is what keeps the launch prompt answerable:
 *
 *  - The DELIVERY LOOP, end to end — get a repo onto the board, put a task on it, run it, answer
 *    it when it asks, read a failure when it comes, read the result and merge it — each tour
 *    requiring the state the previous one produces, so the prompt only ever offers what this
 *    board can actually demonstrate and the catalogue turns the rest into a to-do list rather
 *    than an absence. The loop deliberately covers work going WRONG as well as right
 *    (`diagnose-failure`): a first run fails often, and that was the one state on the whole arc
 *    with no walkthrough.
 *  - The PLATFORM behind it (`offeredAtLaunch: false`) — the engine the agents run on, the
 *    pipelines that sequence them, the standards they read, the systems they talk to, where
 *    their containers and environments come from, and the two libraries that change what a
 *    review or a design is made of. Each is gated on a PERMISSION or a deployment CAPABILITY
 *    rather than on board state, so every one is startable on a brand-new board; offered at
 *    launch they would bury the two tours a first-time user can act on. They are reference
 *    material someone goes and gets from the catalogue when the question comes up, which is why
 *    each covers ONE surface and ends there rather than touring the sidebar: these surfaces open
 *    as modals, so a step after one cannot reach another sidebar entry anyway.
 *
 * The two halves also differ in what they are FOR now that the finish card hands off
 * (`nextTourAfter`): the loop is a course, taken in order, each tour unlocked by the last one's
 * own outcome; the platform half is a shelf. That is why the handoff prefers a launch-offer tour
 * whatever its `order` — a deployment's own reference tour must not cut into the arc.
 */

/**
 * The practice project the tours point at: a deliberately small Hono service, kept
 * unfinished on purpose so there is always a real task to hand an agent.
 *
 * Named in code rather than in `en.json` because it is a repository slug: it must not be
 * translated, and nine other catalogs would each hold their own copy of it to drift.
 */
export const SAMPLE_REPO = 'kibertoad/cat-factory-sample-repository'

/**
 * The preconditions the built-in tours declare, each pairing the gate that decides it with
 * the copy that NAMES it — so a tour the board can't run yet is listed with the one thing
 * still missing instead of being silently absent from the catalogue.
 *
 * Shared constants rather than a literal per tour because several tours need the same fact
 * (`service` gates two of them), and a second copy of a requirement is a second reason string
 * to keep in step with the gate it describes.
 */
export const TUTORIAL_REQUIREMENTS = {
  boardWrite: {
    id: 'board-write',
    labelKey: 'tutorial.requirements.boardWrite',
    met: (gates) => gates.canWriteBoard,
  },
  sourceControl: {
    id: 'source-control',
    labelKey: 'tutorial.requirements.sourceControl',
    met: (gates) => gates.githubAvailable,
  },
  service: {
    id: 'service',
    labelKey: 'tutorial.requirements.service',
    met: (gates) => gates.boardHasService,
  },
  task: {
    id: 'task',
    labelKey: 'tutorial.requirements.task',
    met: (gates) => gates.boardHasTask,
  },
  // One requirement over both kinds of park, mirroring the tour's single `task-resolve`
  // anchor: the card offers ONE attention action whichever way a run is waiting, so splitting
  // this would list two things to go and do where either one alone unlocks the tour.
  waitingAnswer: {
    id: 'waiting-answer',
    labelKey: 'tutorial.requirements.waitingAnswer',
    met: (gates) => gates.boardHasOpenDecision || gates.boardHasPendingApproval,
  },
  finishedRun: {
    id: 'finished-run',
    labelKey: 'tutorial.requirements.finishedRun',
    met: (gates) => gates.boardHasFinishedRun,
  },
  failedRun: {
    id: 'failed-run',
    labelKey: 'tutorial.requirements.failedRun',
    met: (gates) => gates.boardHasFailedRun,
  },
  // Two deployment-capability requirements the newer surfaces need. `infrastructure` is the
  // gate of the sidebar entry its tour clicks (`nav-infrastructure`), which already folds in
  // `integrations.manage`; `advancedTier` is the INTERFACE MODE, and it is a requirement in its
  // own right for the two reasons the README's drift-guard section names: an entry marked
  // `advanced: true` is absent from BASIC mode, which is the shipped default, and a SECTION
  // inside a basic-mode surface can hide itself the same way. Either leaves a tour hunting for
  // an anchor that nearly every user's screen does not render.
  infrastructure: {
    id: 'infrastructure',
    labelKey: 'tutorial.requirements.infrastructure',
    met: (gates) => gates.infrastructureAvailable,
  },
  advancedTier: {
    id: 'advanced-tier',
    labelKey: 'tutorial.requirements.advancedTier',
    met: (gates) => gates.advancedMode,
  },
  // The platform half's requirements. Each mirrors, exactly, the `gate` of the sidebar entry the
  // tour clicks (`nav-model-providers` / `nav-integrations`, `nav-fragments`). A requirement
  // WEAKER than the gate of the control a step points at offers the tour to a user who has no
  // such control: it then hunts for the anchor, skips every step behind it, and reports itself
  // abridged — which is the state this mechanism exists to prevent. They are permissions and
  // deployment wiring rather than board state, which is why those tours are startable on a board
  // with nothing on it, and therefore why they are kept out of the launch offer.
  integrationsManage: {
    id: 'integrations-manage',
    labelKey: 'tutorial.requirements.integrationsManage',
    met: (gates) => gates.canManageIntegrations,
  },
  settingsManage: {
    id: 'settings-manage',
    labelKey: 'tutorial.requirements.settingsManage',
    met: (gates) => gates.canManageSettings,
  },
  library: {
    id: 'library',
    labelKey: 'tutorial.requirements.library',
    met: (gates) => gates.libraryAvailable,
  },
  // The CONNECTION rather than the permission to make one: starting from a design is
  // member-tier, and the frame-header button the tour clicks exists only once some admin has
  // connected a design source. A tour gated on `integrations.manage` would be withheld from
  // exactly the persona it is written for.
  designSource: {
    id: 'design-source',
    labelKey: 'tutorial.requirements.designSource',
    met: (gates) => gates.designSourceConnected,
  },
} as const satisfies Record<string, TutorialRequirement>

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
    requires: [TUTORIAL_REQUIREMENTS.boardWrite, TUTORIAL_REQUIREMENTS.sourceControl],
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
    requires: [TUTORIAL_REQUIREMENTS.boardWrite, TUTORIAL_REQUIREMENTS.service],
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
    requires: [TUTORIAL_REQUIREMENTS.boardWrite, TUTORIAL_REQUIREMENTS.task],
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
    requires: [TUTORIAL_REQUIREMENTS.waitingAnswer],
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
    id: 'diagnose-failure',
    order: 45,
    icon: 'i-lucide-triangle-alert',
    titleKey: 'tutorial.tours.diagnoseFailure.title',
    descriptionKey: 'tutorial.tours.diagnoseFailure.description',
    // The state a first run reaches most often, and the one the catalog had nothing for. Every
    // other delivery-loop tour describes work going right: `review-merge` requires a run that
    // finished SUCCESSFULLY, so a user whose runs all failed was offered a walkthrough of the
    // happy path they cannot reach and no account of the screen they are actually looking at.
    // That is the point at which people conclude the product does not work.
    requires: [TUTORIAL_REQUIREMENTS.failedRun],
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.diagnoseFailure.steps.intro.title',
        bodyKey: 'tutorial.tours.diagnoseFailure.steps.intro.body',
      },
      {
        // The banner, not the card: `TaskCard` swaps its progress bar for the shared failure
        // banner on a failed run, and that banner is the whole subject of this tour.
        id: 'banner',
        target: 'agent-failure-banner',
        placement: 'right',
        titleKey: 'tutorial.tours.diagnoseFailure.steps.banner.title',
        bodyKey: 'tutorial.tours.diagnoseFailure.steps.banner.body',
      },
      {
        // NOT `target-click`, for `design-pipeline`'s reason rather than `run-task`'s: Retry is
        // rendered but DISABLED without `runs.execute`, and a click-to-advance step whose
        // control cannot be clicked drops its Next button and strands the tour. The copy
        // therefore describes retrying rather than instructing it. (A retry also spends model
        // budget, so handing the decision back is right on both counts.)
        id: 'retry',
        target: 'agent-failure-retry',
        placement: 'right',
        titleKey: 'tutorial.tours.diagnoseFailure.steps.retry.title',
        bodyKey: 'tutorial.tours.diagnoseFailure.steps.retry.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.diagnoseFailure.steps.finish.title',
        bodyKey: 'tutorial.tours.diagnoseFailure.steps.finish.body',
      },
    ],
    // Deliberately NOT anchored on `agent-failure-history` or
    // `agent-failure-configure-environment`, both of which the finish card mentions in prose
    // instead. Each renders only in a narrower state than this tour's own requirement (a trail
    // of PRIOR attempts; a failure whose kind is `environment`), so a step on either would need
    // its own `when` and therefore its own gate, added for one step apiece — and left without
    // one it would count as an unexpected skip and tell a user who saw exactly the right
    // walkthrough that they missed part of it.
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
    requires: [TUTORIAL_REQUIREMENTS.finishedRun],
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
  {
    id: 'start-from-design',
    order: 55,
    icon: 'i-lucide-frame',
    titleKey: 'tutorial.tours.startFromDesign.title',
    descriptionKey: 'tutorial.tours.startFromDesign.description',
    // The delivery loop as a DESIGNER enters it, which is a different first step from
    // `first-task`: the work starts from a frame in Figma, not from a title someone types. It
    // rides the loop's order (after the run tours, before the platform half) rather than
    // replacing `first-task`, because it ends in the same add-task form and everything after
    // that point is the arc those tours already cover.
    //
    // Offered at launch, unlike the platform tours, and gated on the design source being
    // CONNECTED: on a board with one, this is the everyday loop rather than reference material.
    requires: [
      TUTORIAL_REQUIREMENTS.boardWrite,
      TUTORIAL_REQUIREMENTS.service,
      TUTORIAL_REQUIREMENTS.designSource,
    ],
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.startFromDesign.steps.intro.title',
        bodyKey: 'tutorial.tours.startFromDesign.steps.intro.body',
      },
      {
        id: 'open',
        target: 'frame-start-from-design',
        advanceOn: 'target-click',
        placement: 'bottom',
        titleKey: 'tutorial.tours.startFromDesign.steps.open.title',
        bodyKey: 'tutorial.tours.startFromDesign.steps.open.body',
      },
      {
        id: 'paste',
        target: 'start-from-design-link',
        // Inside the modal the previous click opens.
        waitForTargetMs: 8000,
        placement: 'bottom',
        titleKey: 'tutorial.tours.startFromDesign.steps.paste.title',
        bodyKey: 'tutorial.tours.startFromDesign.steps.paste.body',
      },
      {
        // Left to the anchor-skip rather than given a `when`: the resolved card appears only
        // once a link has actually been pasted, and someone walking the tour without one in
        // hand should reach the finish card rather than stall on an input they cannot fill.
        id: 'resolved',
        target: 'start-from-design-resolved',
        waitForTargetMs: 8000,
        placement: 'bottom',
        titleKey: 'tutorial.tours.startFromDesign.steps.resolved.title',
        bodyKey: 'tutorial.tours.startFromDesign.steps.resolved.body',
      },
      {
        id: 'continue',
        target: 'start-from-design-continue',
        advanceOn: 'target-click',
        placement: 'top',
        titleKey: 'tutorial.tours.startFromDesign.steps.continue.title',
        bodyKey: 'tutorial.tours.startFromDesign.steps.continue.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.startFromDesign.steps.finish.title',
        bodyKey: 'tutorial.tours.startFromDesign.steps.finish.body',
      },
    ],
  },
  // ---------------------------------------------------------------------------------------
  // The platform half. Ordered after the whole delivery loop so the catalogue reads in the
  // order someone meets these things: learn the loop, then the machinery under it.
  // ---------------------------------------------------------------------------------------
  {
    id: 'wire-models',
    order: 60,
    icon: 'i-lucide-plug-zap',
    titleKey: 'tutorial.tours.wireModels.title',
    descriptionKey: 'tutorial.tours.wireModels.description',
    // The one connection a deployment cannot live without: every pipeline step is a model call,
    // so with no provider the whole product is inert. It is nonetheless catalogue-only, because a
    // deployment with nothing wired already gets its own first-launch nudge (the provider
    // onboarding advisory, which the launch prompt stands down for) — this is for the person who
    // meets the question later, or who wants to know where the answer lives.
    offeredAtLaunch: false,
    requires: [TUTORIAL_REQUIREMENTS.integrationsManage],
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.wireModels.steps.intro.title',
        bodyKey: 'tutorial.tours.wireModels.steps.intro.body',
      },
      {
        id: 'open',
        target: 'nav-model-providers',
        advanceOn: 'target-click',
        placement: 'right',
        titleKey: 'tutorial.tours.wireModels.steps.open.title',
        bodyKey: 'tutorial.tours.wireModels.steps.open.body',
      },
      {
        id: 'hub',
        target: 'model-providers-hub',
        // Inside the modal the previous click opens.
        waitForTargetMs: 8000,
        placement: 'bottom',
        titleKey: 'tutorial.tours.wireModels.steps.hub.title',
        bodyKey: 'tutorial.tours.wireModels.steps.hub.body',
      },
      {
        // Deliberately prose rather than a step pointing at Model configuration: that entry is a
        // sibling in the same sidebar section, and by now the hub modal is open over it, so a
        // step anchored there would spend its wait budget on a control the user cannot reach.
        id: 'finish',
        titleKey: 'tutorial.tours.wireModels.steps.finish.title',
        bodyKey: 'tutorial.tours.wireModels.steps.finish.body',
      },
    ],
  },
  {
    id: 'design-pipeline',
    order: 70,
    icon: 'i-lucide-workflow',
    titleKey: 'tutorial.tours.designPipeline.title',
    descriptionKey: 'tutorial.tours.designPipeline.description',
    // `run-task` teaches picking a pipeline; nothing teaches that the sequence is yours to
    // change. A user who never finds the builder treats the built-in catalog as the product's
    // fixed shape and works around it in task descriptions instead.
    offeredAtLaunch: false,
    requires: [TUTORIAL_REQUIREMENTS.boardWrite],
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.designPipeline.steps.intro.title',
        bodyKey: 'tutorial.tours.designPipeline.steps.intro.body',
      },
      {
        id: 'open',
        target: 'nav-build-pipeline',
        advanceOn: 'target-click',
        placement: 'right',
        titleKey: 'tutorial.tours.designPipeline.steps.open.title',
        bodyKey: 'tutorial.tours.designPipeline.steps.open.body',
      },
      {
        id: 'palette',
        target: 'pipeline-builder-palette',
        // Inside the slideover the previous click opens.
        waitForTargetMs: 8000,
        placement: 'right',
        titleKey: 'tutorial.tours.designPipeline.steps.palette.title',
        bodyKey: 'tutorial.tours.designPipeline.steps.palette.body',
      },
      {
        id: 'chain',
        target: 'pipeline-builder-draft',
        placement: 'right',
        titleKey: 'tutorial.tours.designPipeline.steps.chain.title',
        bodyKey: 'tutorial.tours.designPipeline.steps.chain.body',
      },
      {
        // NOT `target-click`, and not for `run-task`'s budget reason: Save is DISABLED until the
        // draft holds a step, and a click-to-advance step on a control that cannot be clicked
        // strands the tour — the tooltip drops its Next button, so there is no way forward.
        //
        // Which is also why the copy DESCRIBES saving rather than instructing it, and says what
        // lights the button up. The previous step invites a click on the palette but doesn't
        // require one, so this step is routinely read with Save greyed out; an imperative title
        // over a dead control reads as a tour pointing at something broken.
        id: 'save',
        target: 'pipeline-builder-save',
        placement: 'top',
        titleKey: 'tutorial.tours.designPipeline.steps.save.title',
        bodyKey: 'tutorial.tours.designPipeline.steps.save.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.designPipeline.steps.finish.title',
        bodyKey: 'tutorial.tours.designPipeline.steps.finish.body',
      },
    ],
  },
  {
    id: 'agent-standards',
    order: 80,
    icon: 'i-lucide-book-marked',
    titleKey: 'tutorial.tours.agentStandards.title',
    descriptionKey: 'tutorial.tours.agentStandards.description',
    // How you steer output without restating your conventions in every task description, which
    // is what people do instead when they never find this.
    offeredAtLaunch: false,
    requires: [TUTORIAL_REQUIREMENTS.library, TUTORIAL_REQUIREMENTS.settingsManage],
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.agentStandards.steps.intro.title',
        bodyKey: 'tutorial.tours.agentStandards.steps.intro.body',
      },
      {
        id: 'open',
        target: 'nav-fragments',
        advanceOn: 'target-click',
        placement: 'right',
        titleKey: 'tutorial.tours.agentStandards.steps.open.title',
        bodyKey: 'tutorial.tours.agentStandards.steps.open.body',
      },
      {
        id: 'library',
        target: 'fragment-library',
        waitForTargetMs: 8000,
        placement: 'bottom',
        titleKey: 'tutorial.tours.agentStandards.steps.library.title',
        bodyKey: 'tutorial.tours.agentStandards.steps.library.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.agentStandards.steps.finish.title',
        bodyKey: 'tutorial.tours.agentStandards.steps.finish.body',
      },
    ],
  },
  {
    id: 'connect-systems',
    order: 90,
    icon: 'i-lucide-blocks',
    titleKey: 'tutorial.tours.connectSystems.title',
    descriptionKey: 'tutorial.tours.connectSystems.description',
    // Each integration changes what a run can SEE or SAY, and none of them announces itself:
    // a board with no tracker linked simply never mentions that issues could arrive on their own.
    offeredAtLaunch: false,
    requires: [TUTORIAL_REQUIREMENTS.integrationsManage],
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.connectSystems.steps.intro.title',
        bodyKey: 'tutorial.tours.connectSystems.steps.intro.body',
      },
      {
        id: 'open',
        target: 'nav-integrations',
        advanceOn: 'target-click',
        placement: 'right',
        titleKey: 'tutorial.tours.connectSystems.steps.open.title',
        bodyKey: 'tutorial.tours.connectSystems.steps.open.body',
      },
      {
        id: 'hub',
        target: 'integrations-hub',
        waitForTargetMs: 8000,
        placement: 'bottom',
        titleKey: 'tutorial.tours.connectSystems.steps.hub.title',
        bodyKey: 'tutorial.tours.connectSystems.steps.hub.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.connectSystems.steps.finish.title',
        bodyKey: 'tutorial.tours.connectSystems.steps.finish.body',
      },
    ],
  },
  {
    id: 'prepare-infrastructure',
    order: 100,
    icon: 'i-lucide-server-cog',
    titleKey: 'tutorial.tours.prepareInfrastructure.title',
    descriptionKey: 'tutorial.tours.prepareInfrastructure.description',
    // Where agent containers run, what a test environment is brought up from, and which
    // credentials the capabilities an agent uses are allowed to resolve. None of it announces
    // itself, and the cost of not finding it is a run that fails on provisioning with a banner
    // pointing at a window the user has never opened.
    offeredAtLaunch: false,
    requires: [TUTORIAL_REQUIREMENTS.infrastructure],
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.prepareInfrastructure.steps.intro.title',
        bodyKey: 'tutorial.tours.prepareInfrastructure.steps.intro.body',
      },
      {
        id: 'open',
        target: 'nav-infrastructure',
        advanceOn: 'target-click',
        placement: 'right',
        titleKey: 'tutorial.tours.prepareInfrastructure.steps.open.title',
        bodyKey: 'tutorial.tours.prepareInfrastructure.steps.open.body',
      },
      {
        // The tab STRIP, not any one tab's panel. Which tabs exist is itself resolved from three
        // independent availability probes, so a step anchored on a panel inside one of them
        // (`capability-credentials-panel`, `compose-env-setup-section`) points at a control that
        // exists only while that tab is both offered AND selected — and the tour cannot select
        // it, since the click that would is the user's. The strip is what the window always
        // renders, and naming the tabs in the copy is what this tour is for.
        id: 'tabs',
        target: 'infrastructure-tabs',
        waitForTargetMs: 8000,
        placement: 'bottom',
        titleKey: 'tutorial.tours.prepareInfrastructure.steps.tabs.title',
        bodyKey: 'tutorial.tours.prepareInfrastructure.steps.tabs.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.prepareInfrastructure.steps.finish.title',
        bodyKey: 'tutorial.tours.prepareInfrastructure.steps.finish.body',
      },
    ],
  },
  {
    id: 'panel-reviews',
    order: 110,
    icon: 'i-lucide-users',
    titleKey: 'tutorial.tours.panelReviews.title',
    descriptionKey: 'tutorial.tours.panelReviews.description',
    // A review step can run as a multi-model PANEL instead of one agent, chosen per estimate
    // tier from a workspace group library. Nobody guesses that from a pipeline: the step looks
    // like every other review step until a group exists for it to select.
    offeredAtLaunch: false,
    // `advancedTier` is NOT redundant beside `settingsManage`, and the nav drift guard cannot
    // see why: `nav-model-config` is a basic-mode entry, but the consensus SECTION inside that
    // panel renders on `uiMode.isAdvanced || groups.hasGroups`, so on the shipped default tier a
    // workspace that has never made a group renders nothing for the anchored step to find. The
    // guard only pairs a tour against the visibility of a NAV entry, so a section hiding itself
    // one level in is exactly the case that has to be declared by hand.
    requires: [TUTORIAL_REQUIREMENTS.settingsManage, TUTORIAL_REQUIREMENTS.advancedTier],
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.panelReviews.steps.intro.title',
        bodyKey: 'tutorial.tours.panelReviews.steps.intro.body',
      },
      {
        id: 'open',
        target: 'nav-model-config',
        advanceOn: 'target-click',
        placement: 'right',
        titleKey: 'tutorial.tours.panelReviews.steps.open.title',
        bodyKey: 'tutorial.tours.panelReviews.steps.open.body',
      },
      {
        id: 'groups',
        target: 'consensus-group-new',
        waitForTargetMs: 8000,
        placement: 'top',
        titleKey: 'tutorial.tours.panelReviews.steps.groups.title',
        bodyKey: 'tutorial.tours.panelReviews.steps.groups.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.panelReviews.steps.finish.title',
        bodyKey: 'tutorial.tours.panelReviews.steps.finish.body',
      },
    ],
  },
  {
    id: 'share-services',
    order: 120,
    icon: 'i-lucide-library-big',
    titleKey: 'tutorial.tours.shareServices.title',
    descriptionKey: 'tutorial.tours.shareServices.description',
    // The catalog of shared capabilities an org already runs, with the API contracts a design
    // is expected to build ON rather than reinvent. Without it an architect agent designs every
    // service as if the estate were empty.
    offeredAtLaunch: false,
    // `nav-foundational-services` is marked `advanced: true`, so the tier is part of what
    // renders the entry this tour clicks. Declared rather than assumed: `navRequirementDrift`
    // enumerates the whole gate matrix against that entry's own visibility rule and fails
    // without it.
    requires: [TUTORIAL_REQUIREMENTS.settingsManage, TUTORIAL_REQUIREMENTS.advancedTier],
    steps: [
      {
        id: 'intro',
        titleKey: 'tutorial.tours.shareServices.steps.intro.title',
        bodyKey: 'tutorial.tours.shareServices.steps.intro.body',
      },
      {
        id: 'open',
        target: 'nav-foundational-services',
        advanceOn: 'target-click',
        placement: 'right',
        titleKey: 'tutorial.tours.shareServices.steps.open.title',
        bodyKey: 'tutorial.tours.shareServices.steps.open.body',
      },
      {
        id: 'catalog',
        target: 'foundational-manager',
        waitForTargetMs: 8000,
        placement: 'bottom',
        titleKey: 'tutorial.tours.shareServices.steps.catalog.title',
        bodyKey: 'tutorial.tours.shareServices.steps.catalog.body',
      },
      {
        id: 'finish',
        titleKey: 'tutorial.tours.shareServices.steps.finish.title',
        bodyKey: 'tutorial.tours.shareServices.steps.finish.body',
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
