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
 *    it when it asks, read the result and merge it — each tour requiring the state the previous
 *    one produces, so the prompt only ever offers what this board can actually demonstrate and
 *    the catalogue turns the rest into a to-do list rather than an absence.
 *  - The PLATFORM behind it (`offeredAtLaunch: false`) — the engine the agents run on, the
 *    pipelines that sequence them, the standards they read, the systems they talk to. Each is
 *    gated on a PERMISSION rather than on board state, so every one is startable on a brand-new
 *    board; offered at launch they would bury the two tours a first-time user can act on. They
 *    are reference material someone goes and gets from the catalogue when the question comes up,
 *    which is why each covers ONE surface and ends there rather than touring the sidebar: these
 *    surfaces open as modals, so a step after one cannot reach another sidebar entry anyway.
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
]

/** The module that contributes the catalog; registered by `createAppRegistry`. */
export const tutorialToursModule = defineModule({
  id: 'cat-factory:tutorial-tours',
  version: '1.0.0',
  slots: { tutorialTours: [...TUTORIAL_TOURS] },
})
