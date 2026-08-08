import { hasApproverPolicy } from '@cat-factory/contracts'
import type { PipelineRegistry } from './pipeline-registry.js'
import type { TaskTypeRegistry } from './task-type-registry.js'
import type { Block, Pipeline, StepGateConfig, StepGating, StepOptions } from './types.js'

// Sample architecture used to populate a workspace on creation. Mirrors the
// frontend's `app/utils/seed.ts`. Block ids are stable strings; because blocks
// are keyed by (workspace_id, id) every workspace gets its own copy, so reusing
// these ids across workspaces is safe.

export function seedBlocks(): Block[] {
  const base = (b: Partial<Block> & Pick<Block, 'id' | 'title' | 'type' | 'position'>): Block => ({
    description: '',
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'frame',
    parentId: null,
    ...b,
  })

  return [
    base({
      id: 'blk_frontend',
      title: 'Web Frontend',
      type: 'frontend',
      position: { x: 80, y: 80 },
      description: 'Customer-facing SPA consuming the API gateway.',
      status: 'planned',
    }),
    base({
      id: 'blk_api',
      title: 'API Gateway',
      type: 'api',
      position: { x: 620, y: 80 },
      description: 'Single entrypoint; routing, rate limiting, auth checks.',
      status: 'planned',
    }),
    base({
      id: 'blk_payments',
      title: 'Payments (External)',
      type: 'external',
      position: { x: 1160, y: 80 },
      description: 'Third-party payment provider integration.',
      status: 'planned',
    }),
    base({
      id: 'blk_auth',
      title: 'Auth Service',
      type: 'service',
      position: { x: 80, y: 580 },
      description: 'Issues and validates sessions and access tokens.',
      status: 'ready',
    }),
    base({
      id: 'blk_db',
      title: 'Core Database',
      type: 'database',
      position: { x: 620, y: 580 },
      description: 'Primary relational store for users, accounts and orders.',
      status: 'done',
      progress: 1,
    }),
    base({
      id: 'blk_queue',
      title: 'Notification Queue',
      type: 'queue',
      position: { x: 1160, y: 580 },
      description: 'Async fan-out for emails and push notifications.',
      status: 'planned',
    }),

    // Tasks (draggable) inside the Auth Service.
    base({
      id: 'task_login',
      title: 'Login endpoint',
      type: 'service',
      position: { x: 24, y: 96 },
      description: 'Issue a session on valid credentials.',
      status: 'planned',
      level: 'task',
      parentId: 'blk_auth',
      moduleName: 'Sessions',
    }),
    base({
      id: 'task_refresh',
      title: 'Token refresh',
      type: 'service',
      position: { x: 230, y: 96 },
      description: 'Rotate access tokens against a refresh token.',
      status: 'planned',
      level: 'task',
      parentId: 'blk_auth',
      moduleName: 'Sessions',
      dependsOn: ['task_login'],
    }),

    // A module that already exists, with an implemented task living inside it.
    base({
      id: 'mod_sessions',
      title: 'Sessions',
      type: 'service',
      position: { x: 24, y: 250 },
      description: 'Session lifecycle module.',
      level: 'module',
      parentId: 'blk_auth',
    }),
    base({
      id: 'task_session',
      title: 'Session store',
      type: 'service',
      position: { x: 16, y: 40 },
      description: 'Persist and look up active sessions.',
      status: 'done',
      progress: 1,
      level: 'task',
      parentId: 'mod_sessions',
      moduleName: 'Sessions',
      confidence: 0.92,
    }),
  ]
}

/**
 * A pipeline step in the readable seed form. A bare kind string is an ENABLED step with no human
 * gate; the object form NAMES the step's human `gate` (approval pause), marks it opt-in
 * (`enabled: false` — present in the preset but disabled by default), and/or declares its estimate
 * `gating` (skip the step unless the task estimate clears a threshold). This replaces the fragile
 * index-aligned `gates`/`enabled`/`gating` arrays: each is declared BY NAME on its own step, so
 * inserting a step (e.g. a `deployer` before the tester) can never shift a positional flag onto the
 * wrong step.
 *
 * `gate` is the extension seam it was always meant to be: `true` is a plain human checkpoint, and
 * an OBJECT is that step's gate CONFIGURATION, lowering into `stepOptions[i].gateConfig`, so a
 * configured gate needs no new array and no new column. See
 * `backend/docs/adr/0038-per-step-gate-config.md`.
 *
 * The object form does NOT imply a human checkpoint by itself, because the two halves of
 * `StepGateConfig` answer different questions. `approvers` / `minApprovals` configure the human
 * gate and therefore raise `gates[i]`; `fields` configures the REGISTERED gate the step's kind
 * already runs (a `ci` step's attempt budget, a `post-release-health` step's watch window), which
 * has nothing to do with pausing for a person. Lowering `{ fields: … }` into `gates[i] = true`
 * would bolt a human approval pause onto a `ci` step whose author only wanted three fixer rounds
 * silently, since nothing downstream can tell an intended checkpoint from an inferred one.
 * `assertValidGateConfig` draws the same line at the other door: it requires `gates[i]` for the
 * approval half and never for `fields`.
 *
 * `gate` and `gating` are mutually exclusive on one step, and `validatePipelineShape` enforces
 * that rather than this type: the estimate may ADD a human checkpoint but never cancel an approval
 * pause the author asked for. A pipeline declaring both fails the kernel seed test.
 */
type SeedStep =
  | string
  | {
      kind: string
      gate?: boolean | StepGateConfig
      enabled?: boolean
      gating?: StepGating
      /** Non-gate per-step options a built-in needs (merged under any `gate` config it declares). */
      options?: StepOptions
    }

/**
 * Lower a named-step pipeline spec into the wire {@link Pipeline} (index-aligned
 * `agentKinds`/`gates`/`enabled`/`gating`/`stepOptions`). Each array is emitted ONLY when a step
 * actually declares the corresponding flag, so a plain all-enabled, gate-less pipeline stays as
 * bare `agentKinds` — its persisted shape is byte-identical to the hand-authored form.
 */
function definePipeline(spec: {
  id: string
  name: string
  description?: string
  purpose?: Pipeline['purpose']
  steps: readonly SeedStep[]
  availability?: Pipeline['availability']
  labels?: string[]
  version?: number
  public?: boolean
}): Pipeline {
  const norm = spec.steps.map((s) => (typeof s === 'string' ? { kind: s } : s))
  // A human checkpoint is `gate: true`, or an object configuring the APPROVAL half. An object that
  // only carries `fields` configures the step's registered gate and raises no checkpoint. See the
  // `SeedStep` docs for why conflating the two would be a silent pause nobody authored.
  const gates = norm.map(
    (s) =>
      s.gate === true ||
      (typeof s.gate === 'object' &&
        (hasApproverPolicy(s.gate.approvers) || s.gate.minApprovals !== undefined)),
  )
  const enabled = norm.map((s) => s.enabled !== false)
  const gating = norm.map((s) => s.gating ?? null)
  const stepOptions = norm.map((s) => {
    const options: StepOptions = {
      ...s.options,
      ...(typeof s.gate === 'object' ? { gateConfig: s.gate } : {}),
    }
    return Object.keys(options).length ? options : null
  })
  return {
    id: spec.id,
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    agentKinds: norm.map((s) => s.kind),
    ...(gates.some(Boolean) ? { gates } : {}),
    ...(enabled.some((e) => !e) ? { enabled } : {}),
    ...(gating.some((g) => g !== null) ? { gating } : {}),
    ...(stepOptions.some((o) => o !== null) ? { stepOptions } : {}),
    ...(spec.availability ? { availability: spec.availability } : {}),
    ...(spec.purpose ? { purpose: spec.purpose } : {}),
    ...(spec.labels ? { labels: spec.labels } : {}),
    ...(spec.version !== undefined ? { version: spec.version } : {}),
    ...(spec.public ? { public: spec.public } : {}),
  } as Pipeline
}

// The built-in pipeline catalog is split across three cohesive builders (delivery, build
// variants, specialty) purely so no single function exceeds the size budget; `seedPipelines`
// below composes them in order. Each returns plain `Pipeline[]` and shares the module-level
// `definePipeline` helper.
function buildDeliveryPipelines(): Pipeline[] {
  return [
    // ---- The build ladder: three fixed rungs plus one adaptive preset ---------------------
    //
    // The catalog collapse (docs/initiatives/pipeline-catalog-collapse.md) replaced seven
    // near-identical build presets with a deliberate ladder. The axis is HOW MUCH DESIGN a task
    // gets, because that is the only axis anyone actually chose a build pipeline on:
    //
    //   pl_build   (DEFAULT) design → implement → review → verify → guards → merge
    //   pl_simple            implement → review → verify → guards → merge
    //   pl_full    (adaptive) sizes the task and switches its own optional steps on
    //
    // All three share the same non-negotiable tail — `conflicts → ci → merger` — so no rung can
    // merge over a conflict or a red build, and each opens exactly one PR that `merger` lands
    // according to the task's merge preset (automatically, or held for a person).
    //
    // ORDER IS LOAD-BEARING: `seedPipelines()[0]` is the positional default a plain "Start"
    // resolves (see TaskCard's `pipelines.pipelines[0]`), so the default rung must stay first.

    // THE DEFAULT. The everyday programmatic loop: work out the shape of the solution, build it,
    // review it, verify it, pass the guards, merge. Every step is UNCONDITIONAL, so a run's shape
    // is known before it starts and is the same every time.
    //
    // It includes the `architect` because the design step is what stops the coder from inventing an
    // approach mid-implementation, and its inline `architect-companion` because a design nobody
    // challenges is just the first idea — the companion rates it and loops the architect back below
    // threshold, converging without a human in the loop.
    //
    // It deliberately STOPS there. What it omits, and why each is more than the everyday loop
    // needs: `requirements-review` (an iterative human answer/dismiss/re-review conversation that
    // parks the run — the right tool for genuinely ambiguous scope, overkill for a task someone
    // already wrote down), `spec-writer` (mutates the in-repo spec baseline), `researcher`,
    // `mocker` (authors and commits WireMock mappings), `blueprints` (rewrites the service map),
    // `code-commenter`, the docs kinds, and any human approval gate. All remain available as
    // opt-in steps in the builder; they are omitted rather than shipped disabled so the preset's
    // step list reads as exactly what it does.
    {
      id: 'pl_build',
      name: 'Standard build',
      purpose: 'build',
      description:
        'The default: design the solution and challenge the design, implement and review the change, run the tests, then gate on conflicts + CI and merge. Every step always runs — no requirements interview, no human pauses.',
      // Version 2 appends the terminal `disposer`: a Deployer that stands an environment up now
      // has to say where it comes down again (see `validatePipelineAuthoring`), and the bump is
      // what offers an already-seeded workspace the reseed that adopts it.
      version: 2,
      agentKinds: [
        'architect',
        'architect-companion',
        'coder',
        'reviewer',
        'deployer',
        'tester-api',
        'conflicts',
        'ci',
        'merger',
        'disposer',
      ],
    },
    // The TRIVIAL rung: the plainest thing that can ship a change. `pl_build` minus the design
    // phase, for work whose approach is not in question — a copy fix, a version bump, a one-line
    // guard. Unconditional like `pl_build`, and with no estimator either: a pipeline that cannot
    // escalate has nothing to consult an estimate for, so paying for one would be pure overhead.
    //
    // `deployer` stays because it PROVISIONS the environment `tester-api` reads
    // (`assertDeployerBeforeConsumer`) and is a no-op on an infraless service — it adds no
    // complexity a service hasn't already declared.
    {
      id: 'pl_simple',
      name: 'Simple build',
      purpose: 'build',
      description:
        'For trivial work whose approach is not in question: implement and review the change, run the tests, then gate on conflicts + CI and merge. No design phase, no human pauses, no surprises.',
      // Version 5 is the catalog collapse: `mocker` dropped, because authoring stub mappings is not
      // part of the plainest path to a merged change. Version 6 appends the terminal `disposer`.
      version: 6,
      agentKinds: [
        'coder',
        'reviewer',
        'deployer',
        'tester-api',
        'conflicts',
        'ci',
        'merger',
        'disposer',
      ],
    },
    // The ADAPTIVE rung: the same delivery loop, but it sizes the task up first and switches the
    // expensive optional steps on only when the work warrants them. Pick this over the fixed rungs
    // when a service's tasks vary enough in size that ONE fixed shape is wrong for most of them —
    // it is the rung that picks between the other two per task, rather than per service.
    //
    // A `task-estimator` runs first — one cheap inline call — and the optional steps are
    // ESTIMATE-GATED off it:
    //
    //   - `architect` (+ its companion, which cascades) above a complexity bar. This is exactly the
    //     `pl_simple`-vs-`pl_build` choice, made per task from the estimate instead of once by
    //     whoever picked the pipeline.
    //   - `tester-api` above a low complexity/risk bar, so a trivial change isn't charged a
    //     verification pass its own diff can't justify.
    //   - `human-review` above a HIGH risk bar. This is the escalation direction: the default is
    //     to merge on the preset's thresholds, and a genuinely risky change additionally waits for
    //     a person on the PR. It replaces the whole `pl_pr_review` preset.
    //
    // So a trivial task runs estimator → coder → reviewer → deployer → conflicts → ci → merger,
    // and a risky one runs the full ladder. `deployer` is unconditional because it PROVISIONS the
    // environment the tester reads (`assertDeployerBeforeConsumer`) and is a no-op on an infraless
    // service; `conflicts`/`ci`/`merger` are unconditional because "pass the guards" is not
    // negotiable on task size.
    //
    // Everything the old `pl_full`/`pl_fullstack` carried unconditionally — the requirements
    // review, spec increment, researcher, mocks, blueprints refresh, comment pass, docs, e2e
    // tests — remains available as opt-in steps in the builder. They are omitted here rather than
    // shipped disabled so the default's step list reads as what it does.
    definePipeline({
      id: 'pl_full',
      name: 'Adaptive build',
      purpose: 'build',
      description:
        'Sizes the task up first, then designs it only when it needs designing, implements and reviews, verifies, and gates on conflicts + CI before merging. Optional steps switch themselves on for bigger tasks — a risky change also waits for a human review on the PR.',
      // Version 6 is the catalog collapse: the preset went from 15 unconditional steps to a gated
      // 7-to-10 and absorbed pl_quick / pl_dep_update / pl_pr_review / pl_human_review /
      // pl_fullstack / pl_integrate, which are retired (see buildRetiredPipelines). The bump is what
      // offers an already-seeded workspace the reseed. Version 7 appends the terminal `disposer`.
      version: 7,
      steps: [
        // Sizes the task so every gate below has an estimate to read. Inline + cheap, and
        // `assertValidGating` requires it to precede any gated step.
        'task-estimator',
        {
          kind: 'architect',
          gating: { enabled: true, minComplexity: 0.4, onMissingEstimate: 'run' },
        },
        // Deliberately carries NO gate of its own: it CASCADES with the architect, skipped
        // automatically whenever its producer was (see `producerWasSkipped`). Repeating the
        // architect's threshold here would be a second copy to keep in sync, and the two could
        // only ever disagree by leaving a design unreviewed.
        'architect-companion',
        'coder',
        // The coder's companion — unconditional. A code review is the cheapest defect-catching
        // step in the run, and gating it is what made pl_quick and pl_simple different pipelines.
        'reviewer',
        // Stands a kubernetes/custom/compose env up for the tester; a no-op otherwise. NOT gatable
        // — it provisions what its consumer reads.
        'deployer',
        {
          kind: 'tester-api',
          gating: { enabled: true, minComplexity: 0.3, minRisk: 0.3, onMissingEstimate: 'run' },
        },
        'conflicts',
        'ci',
        // Waits for a real human review on the PR once risk clears the bar — escalation, not a
        // gate the estimate can cancel (it carries no `gate: true`, so the exclusivity rule is
        // satisfied). A pass-through until a PR-review provider is wired.
        {
          kind: 'human-review',
          gating: { enabled: true, minRisk: 0.8, onMissingEstimate: 'skip' },
        },
        'merger',
        // Terminal, for the same reason it is terminal in `pl_bug_triage`: every earlier slot
        // would reclaim the environment while a later step might still want it, and the merge is
        // the last thing in this chain that can. Unconditional even though its provider (the
        // tester) is estimate-gated: the Deployer above is unconditional too, so a trivial task
        // still stands an environment up and still has to give it back.
        'disposer',
      ],
    }),
    // A bug-fix preset, front-loaded with the investigate → triage pair: `bug-investigator` reads
    // the codebase from the raw report (read-only) and emits an enriched report; `clarity-review`
    // triages it for fixability (the ONLY human gate — the iterative answer → incorporate → re-review
    // loop); `spec-writer` folds the clarified brief into the spec; architect → `repro-test` → coder
    // → reviewer is the core; conflicts → ci → merger is the standard tail.
    //
    // `repro-test` sits between the design and the fix, exactly where `pl_bug_triage` puts it: it
    // writes a FAILING test onto the shared work branch that the coder then resumes. It belongs in
    // a bugfix preset on its own merits (produce a red test before the fix), and it is also the
    // declaration seam the reproduction proof reads — without it the coder's PR carries no evidence
    // that the defect ever manifested, which is the one claim a bugfix PR is really making. The
    // step never blocks: an agent that cannot reproduce the bug concedes structurally, and the
    // concede is published on the PR with its reason rather than looking like nobody tried.
    definePipeline({
      id: 'pl_bugfix',
      name: 'Triage & fix bug',
      purpose: 'build',
      // Bumped for the reseed offer that adopts the `repro-test` step into existing workspaces.
      version: 4,
      description:
        'Investigate a bug report against the codebase, triage it for fixability with you, write a failing reproduction test, then fix, review, and ship the PR.',
      steps: [
        'bug-investigator',
        { kind: 'clarity-review', gate: true },
        'spec-writer',
        'architect',
        'repro-test',
        'coder',
        'reviewer',
        'conflicts',
        'ci',
        'merger',
      ],
    }),
    // The "Ralph loop": a single persistent, retry-until-done coding step. Each iteration is
    // a fresh-context container run that works the task spec, after which the harness runs the
    // task's configured programmatic validation command (exit 0 = done) and the engine loops
    // the iteration until it passes or the per-task budget is spent — then the standard
    // conflicts / CI / merge tail ships the validated PR. The completion criterion and
    // iteration budget are per-task agent config on the `ralph` step (no design/spec phases;
    // the task description is the spec, and prior iterations' validation output is threaded
    // forward as feedback). See backend/docs/ralph-loop.md.
    {
      id: 'pl_ralph',
      name: 'Ralph loop',
      purpose: 'build',
      version: 3,
      description:
        'A single persistent coding step that retries against your validation command until it passes, then gates and ships the PR.',
      agentKinds: ['ralph', 'conflicts', 'ci', 'merger'],
    },
  ]
}

function buildBuildVariantPipelines(): Pipeline[] {
  return [
    // A UI-focused build: implement → review → mock → the UI tester drives a browser through
    // the new screens (capturing a screenshot of each distinct view), then a
    // `visual-confirmation` gate PARKS for a person to review those screenshots against the
    // uploaded reference designs before the standard mergeability / CI / merge tail. From the
    // gate the human approves or requests a fix (the Tester's `fixer`). Opt-in — it needs a
    // human present, the UI-tester image, and a binary-artifact store, so it is NOT folded into
    // the always-on defaults; the gate passes through when no store is wired.
    //
    // EXPERIMENTAL (labelled as such): `tester-ui` auto-capture is not wired end-to-end yet —
    // routing a job into the dedicated UI-tester image and the harness env-passthrough are the
    // remaining deploy-time steps (see the visual-confirmation handover doc). Until they land,
    // the `tester-ui` step has no browser and the gate is driven in MANUAL mode (a human uploads
    // the reference designs + screenshots and reviews them). The `experimental` label keeps the
    // pipeline discoverable but clearly flagged in the library so it isn't picked expecting
    // automatic capture.
    {
      id: 'pl_visual',
      name: 'Build & visual confirmation',
      purpose: 'build',
      description:
        'Implement and UI-test, then pause for a person to compare the captured screenshots against the reference designs before gating and merging.',
      labels: ['experimental'],
      // Version 5 appends the terminal `disposer`. It lands AFTER the human visual-confirmation
      // gate for the reason that gate exists: a person is looking at the live environment, so
      // reclaiming it before they have finished would take the thing under review away.
      version: 5,
      agentKinds: [
        'coder',
        'reviewer',
        'mocker',
        'deployer',
        'tester-ui',
        'visual-confirmation',
        'conflicts',
        'ci',
        'merger',
        'disposer',
      ],
    },
    // A self-contained FRONTEND build + UI-test pipeline: implement → review → mock →
    // `tester-ui` drives a real browser against the frontend the platform stood up for it.
    // Unlike `pl_visual` (a human `visual-confirmation` gate over uploaded reference designs),
    // this is the fully-automated, self-contained flow slice 3 wired: for a `type: 'frontend'`
    // frame the engine resolves the frame's `frontendConfig` + backend bindings, and the `ui`
    // container builds the app from its branch, injects the resolved backend URLs (a bound
    // service's live ephemeral env, else WireMock), stands WireMock up for every OTHER upstream
    // from the frontend repo's `mocks/` mappings, serves the built app, and runs `tester-ui`
    // against the two together — no docker-compose, no DinD. `mocker` runs first so those
    // WireMock mappings exist (it is frontend-aware: it authors them under `mocks/mappings`).
    // `conflicts` / `ci` / `merger` gate and ship the PR like every other build pipeline.
    //
    // EXPERIMENTAL (labelled as such): one deploy-time step remains before this is fully
    // end-to-end. `image: 'ui'` per-step routing is not wired yet — a run's first step fixes the
    // container image (see slice 3's `Dockerfile.ui` note), so `tester-ui` only gets the frontend
    // toolchain when the whole run uses the `ui` image. (Live-service env keying landed in slice
    // 4b: a bound service's ephemeral env is now recorded under the service FRAME the binding
    // names, so a live-service binding resolves to its real URL instead of WireMock; a MOCK-ONLY
    // frontend also runs fully self-contained.) The `experimental` label keeps the pipeline
    // discoverable but clearly flagged until the `ui`-image routing lands.
    {
      id: 'pl_frontend',
      name: 'Frontend build & UI test',
      purpose: 'build',
      description:
        'A self-contained frontend build that drives a real browser against the app the platform stands up, then gates on conflicts + CI and ships the PR.',
      labels: ['experimental'],
      // Version 5 appends the terminal `disposer`.
      version: 5,
      agentKinds: [
        'coder',
        'reviewer',
        'mocker',
        'deployer',
        'tester-ui',
        'conflicts',
        'ci',
        'merger',
        'disposer',
      ],
    },
    // The recurring TECH-DEBT preset: a read-only `analysis` agent audits the repo and a
    // `tracker` step files an issue/ticket from the findings before the standard build tail
    // implements and ships the fix. Picked when creating a recurring pipeline on a service.
    //
    // Dependency updates used to be a preset of its own here; it was exactly the default build
    // tail under a different name, so a schedule now points at `pl_full` for that.
    {
      id: 'pl_tech_debt',
      name: 'Tech debt',
      purpose: 'build',
      description:
        'Audit the repository, file a tracker ticket from the findings, then implement, test, and ship the fix.',
      // Version 5 appends the terminal `disposer`.
      version: 5,
      agentKinds: [
        'analysis',
        'tracker',
        'coder',
        'reviewer',
        'blueprints',
        'mocker',
        'deployer',
        'tester-api',
        'conflicts',
        'ci',
        'merger',
        'disposer',
      ],
    },
    definePipeline({
      // The recurring bug-triage pipeline: each scheduled fire pulls ONE matching issue
      // from the workspace's configured tracker board (`bug-intake`, an engine step that
      // rewrites the reused recurring block from the picked issue), investigates the bug
      // across every involved service's repo (`bug-investigator`, a structured multi-repo
      // read-only explore), asks a human for clarification when the report is unclear
      // (`clarity-review` — auto-passes when the investigation is `clear`, parks otherwise),
      // estimates the work once the problem is understood (`task-estimator`, so the estimate
      // is available to gate the expensive downstream steps), writes a failing reproduction
      // test that may concede without failing the run (`repro-test`, which SEEDS the shared
      // work branch), fixes the reported bug (`coder`, which resumes that branch and opens the
      // PR), reviews it (`reviewer` companion), verifies it in an ephemeral env (`tester-api`),
      // and drives the fix through the standard mergeability / CI / merge tail. On merge the
      // existing tracker writeback closes the issue.
      //
      // `availability: 'recurring'` (design §2): a `bug-intake` step pulls its work from a
      // schedule's tracker board, so this pipeline is meaningless as a one-off — the launch
      // gate (`assertPipelineLaunchable`) refuses a manual start and the SPA hides it from the
      // one-off picker while surfacing it in the recurring modal. The closest reference preset
      // is `pl_bugfix` (the investigate → clarity head) extended with the intake front + the
      // repro/estimate/test/gates tail. Only `clarity-review` is a human gate; the read-only
      // investigator auto-advances and the conflicts/ci/merger tail self-drives.
      id: 'pl_bug_triage',
      name: 'Bug triage (recurring)',
      purpose: 'build',
      description:
        'A recurring run that pulls one open issue from your tracker board, investigates and clarifies it, then fixes, tests, and ships the PR, reclaiming the environment it stood up.',
      availability: 'recurring',
      // A `deployer` runs before the tester (k8s/custom only; a no-op otherwise). Only
      // `clarity-review` is a human gate; version bumped for the reseed offer, then again for the
      // pipeline-description reseed, then again for the purpose classifier reseed, then again for
      // the terminal `disposer`.
      version: 5,
      steps: [
        'bug-intake',
        'bug-investigator',
        { kind: 'clarity-review', gate: true },
        'task-estimator',
        'repro-test',
        'coder',
        'reviewer',
        'deployer',
        'tester-api',
        'conflicts',
        'ci',
        'merger',
        // Closes the run's own teardown proof, and this preset had it first because nobody is
        // watching a scheduled run: a recurring triage fires on a cadence into an empty room, so
        // leaving the environment to the 2-minute `expires_at` sweep compounds the cost once per
        // fire and publishes "still live" as the PR's third lifecycle leg. Every deploying preset
        // now ends this way, because a Deployer with nowhere to come down again is the shape
        // `validatePipelineAuthoring` refuses.
        //
        // TERMINAL, after `merger`, for the same reason the deferred plan recommended it: every
        // earlier slot would reclaim the environment while a later step might still want it, and
        // the merge is the last thing in this chain that can. Safe there because the merger's
        // resolver owns the block's terminal status (`ownsTerminalStatus`) independently of its
        // position, so a step after it neither delays nor overwrites `done`, and because the
        // disposer NEVER fails a run: the work has shipped by the time it runs, so an
        // unreclaimed environment is a recorded warning and the TTL sweep is still the backstop.
        'disposer',
      ],
    }),
    // A blueprint-only pipeline, run after a bootstrap to create the initial
    // service map (and populate the board) from the freshly bootstrapped repo.
    {
      id: 'pl_blueprint',
      name: 'Map service',
      purpose: 'build',
      version: 3,
      description:
        'Map the repository into the service → modules blueprint and populate the board (run after a bootstrap).',
      agentKinds: ['blueprints'],
    },
  ]
}

function buildSpecialtyPipelines(): Pipeline[] {
  return [
    // The PR deep-review pipeline (the DEFAULT for a `review` task): a single read-only
    // `pr-reviewer` step that slices an open PR's diff into cohesive chunks, reviews each,
    // and returns prioritized findings. No code is written and no PR is opened, so there is
    // no merge tail — the run terminates cleanly via the no-PR terminal path in
    // `RunStateMachine.finalizeBlock`. See backend/docs/adr/0023-pr-deep-review.md.
    {
      id: 'pl_review',
      name: 'Review a pull request',
      purpose: 'review',
      // Version bumped for the large-PR / chunked-review description reseed.
      version: 4,
      description:
        'A read-only deep review of an open pull request that returns prioritized findings — no code is written and no PR is opened. Built for large PRs: it slices the diff into cohesive chunks and reviews each one, so it can work through a big change over a longer run rather than choking on it in a single pass.',
      agentKinds: ['pr-reviewer'],
    },
    definePipeline({
      // The Initiative Planning pipeline — the ONLY pipeline runnable on an
      // `initiative`-level block (and initiative blocks accept no other; see the
      // engine's runnable guard). The ANALYST reads the repo FIRST and writes a
      // codebase analysis (including the open questions only a human can settle); the
      // INTERVIEWER — grounded in that analysis — then interviews the human on goals /
      // constraints (an inline park/answer/resume gate driven by its own controller,
      // NOT a `gates[]` human gate — hence `false` at its index); the PLANNER —
      // grounded in both — emits the multi-phase plan as structured output; the HUMAN
      // GATE after it (index 2) holds the run until the plan is approved; the committer
      // then persists the plan (the `initiatives` entity + the in-repo tracker under
      // `docs/initiatives/<slug>/`) and arms the execution loop.
      //
      // ANALYST-BEFORE-INTERVIEWER is load-bearing, not cosmetic. The interviewer is an
      // INLINE kind with no checkout, so an interviewer that runs first can only ask the
      // stakeholder what the repository would have told it — which is exactly what it did,
      // interrogating humans about their own code instead of reading it. Ordering the
      // read-only exploration first is what lets the interview spend its rounds on intent,
      // priorities and tolerances, the facts no amount of exploration can recover.
      id: 'pl_initiative',
      name: 'Plan initiative',
      purpose: 'planning',
      description:
        'Explore the codebase, interview you on what the code cannot answer, and draft a multi-phase plan for approval before committing it.',
      // Slice 2 added the interviewer + analyst in front of the planner; version bumped for the
      // reseed offer. The interviewer parks via its own controller (not a `gate`); the only human
      // gate is on the planner's output, before the committer persists it. Bumped again for the
      // pipeline-description reseed, then again for the purpose classifier reseed, then again for
      // the analyst-before-interviewer reorder (which also rewrote the description).
      version: 5,
      steps: [
        'initiative-analyst',
        'initiative-interviewer',
        { kind: 'initiative-planner', gate: true },
        'initiative-committer',
      ],
    }),
    // The Documentation-refresh preset's planning pipeline (initiative-presets slice 8): the SAME
    // analyst → planner → committer as `pl_initiative` but with NO interviewer (the preset's form
    // IS the interview — `interview: 'skip'` seeds the qa) and NO human gates. The planner is
    // steered into a documentation gap-audit → phased plan by the preset's promptAdditions +
    // phaseTemplate; human review is opt-in per SPAWNED task via the gate-override seam
    // (`item.spawn.gates`), not on the planning run — so the plan itself runs unattended. Kind-keyed
    // (analyst/planner/committer are initiative kinds), so it is legal on an initiative block.
    {
      id: 'pl_initiative_docs',
      name: 'Plan documentation refresh',
      purpose: 'planning',
      version: 3,
      description:
        'Audit the codebase for documentation gaps and draft a phased documentation-refresh plan — no interview, runs unattended.',
      agentKinds: ['initiative-analyst', 'initiative-planner', 'initiative-committer'],
    },
    // A spec-only pipeline, to (re)generate a service's unified in-repo specification
    // (and its Gherkin acceptance scenarios) independently.
    {
      id: 'pl_spec',
      name: 'Write spec',
      purpose: 'build',
      version: 3,
      description:
        '(Re)generate the unified in-repo specification for a service and its Gherkin acceptance scenarios, independently.',
      agentKinds: ['spec-writer'],
    },
    definePipeline({
      // The SPIKE pipeline — a timeboxed research/investigation task that produces a findings
      // document, delivered as a PULL REQUEST (the default). It is the type-default a
      // `taskType: 'spike'` task is pinned to at creation ({@link defaultPipelineIdForTaskType});
      // the full-build `pl_full` (the positional default) is wrong for a research task. A
      // `requirements-review` gate leads (off by default — a spike's criteria are usually clear,
      // and the gate is a pass-through when unwired), then the read-only `spike` explore agent
      // investigates + returns structured findings, whose backend post-op commits
      // `docs/research/<slug>.md` to a work branch and opens a PR (it sees a merge tail via
      // `RepoOpContext.opensPr`). The `conflicts → ci → human-review → merger` tail then reviews
      // (the human-review gate + fixer react to PR review comments, a pass-through until a
      // PR-review provider is wired) and merges it — so protected base branches are respected and
      // the findings land through review, not a force-push. Use `pl_spike_direct` for the fast,
      // no-PR path on an unprotected repo.
      id: 'pl_spike',
      name: 'Run a spike',
      purpose: 'research',
      version: 3,
      description:
        'A timeboxed read-only investigation that answers a research question and delivers a findings document as a pull request.',
      steps: [
        { kind: 'requirements-review', gate: true, enabled: false },
        'spike',
        'conflicts',
        'ci',
        'human-review',
        'merger',
      ],
    }),
    definePipeline({
      // The DIRECT spike pipeline — the fast, no-PR path: the read-only `spike` explore agent,
      // whose post-op commits the findings `docs/research/<slug>.md` STRAIGHT onto the base
      // branch (best-effort — see `spikePostOp`) with no review/merge tail. Since it has no
      // `merger`, `RepoOpContext.opensPr` is false and the run reaches `done` via the engine's
      // no-PR completion path (see `RunStateMachine.finalizeBlock`). Opt-in for unprotected repos
      // / throwaway research where the PR round-trip of `pl_spike` isn't wanted.
      id: 'pl_spike_direct',
      name: 'Run a spike (direct commit)',
      purpose: 'research',
      version: 3,
      description:
        'A timeboxed read-only investigation that commits its findings document straight to the base branch — no PR or review tail.',
      steps: [{ kind: 'requirements-review', gate: true, enabled: false }, 'spike'],
    }),
    // An analyst-only pipeline: the opt-in `environment-analyst` clones a service's repo
    // read-only and drafts a declarative Docker Compose stack recipe (setup steps,
    // prerequisites, health gate) as a NON-BINDING recommendation. The setup wizard runs it
    // against a service frame and merges the draft over the deterministic detection; nothing is
    // applied until the human confirms. See docs/initiatives/stack-recipes-and-shared-stacks.md.
    {
      id: 'pl_environment_analysis',
      name: 'Analyze environment',
      purpose: 'research',
      version: 3,
      description:
        'Read the service repository and draft a non-binding Docker Compose stack-recipe recommendation for the setup wizard.',
      agentKinds: ['environment-analyst'],
    },
    // The first PUBLIC-API pipeline: a single inline `initiative-breakdown` step that
    // decomposes an initiative brief into a structured plan. `public: true` exposes it to
    // external callers via `POST /api/v1/jobs`; being inline (no container / no repo)
    // it runs headlessly and persists its result to the DB, never touching GitHub. The kind
    // itself is registered in @cat-factory/agents (like every other kind referenced here).
    {
      id: 'pl_initiative_breakdown',
      name: 'Break down initiative',
      purpose: 'planning',
      version: 3,
      description:
        'Decompose an initiative brief into a structured plan headlessly (inline, no repo) — the first pipeline exposed to the public API.',
      agentKinds: ['initiative-breakdown'],
      public: true,
    },
    definePipeline({
      // FORWARD document authoring: turn a brief (+ linked PRDs/RFCs/issues) into a polished
      // in-repo Markdown document shipped as a PR. Unlike the reverse-documentation kinds
      // (documenter / business-documenter / blueprints) that describe existing code, this
      // produces a NEW document (PRD / RFC / design / ADR / technical reference / runbook /
      // research report — driven by the task's `docKind`).
      //
      //   doc-researcher  → investigate the topic, prior art and linked context (inline)
      //   doc-outliner    → propose a kind-appropriate outline (inline)
      //   doc-interviewer → converse with the human to refine scope/audience/structure — an
      //                     inline LLM that PARKS the run on a decision-wait while they answer
      //                     through the interview window, then synthesizes a refined authoring
      //                     brief the writer starts from (WS5). Replaces the old binary outline
      //                     human gate with an iterative Q&A; parks via its OWN controller (not a
      //                     `gates[]` human gate — hence `false` at its index, like the
      //                     initiative interviewer)
      //   doc-writer      → write the document as Markdown and open a PR (container-coding)
      //   doc-reviewer    → the writer's companion: rate the draft and loop it back for rework
      //                     below threshold (AI-to-AI convergence) — HUMAN GATE on the converged
      //                     draft, whose feedback the finalizer folds in via the revision context
      //   doc-finalizer   → final editorial pass on the PR branch (container-coding, no new PR)
      //   doc-quality     → deterministic structural gate (required sections / placeholders /
      //                     links / heading hierarchy); loops the `doc-fixer` on a red verdict
      //   conflicts → ci → merger → the same mergeability / CI / merge tail as a code pipeline
      id: 'pl_document',
      name: 'Author a document',
      purpose: 'document',
      description:
        'Turn a brief and its linked context into a polished in-repo Markdown document — research, outline, interview, write, review, then gate and ship the PR.',
      // Slice WS5 inserted the interactive `doc-interviewer` after the outliner and replaced the
      // outline's binary human gate with its iterative loop; version bumped for the reseed offer. The
      // interviewer parks via its OWN controller (not a `gate`), `doc-quality` is a polling gate
      // (auto), so the only human `gate` is the converged review (`doc-reviewer`, after its loop).
      // Bumped again for the pipeline-description reseed, then again for the purpose classifier reseed.
      version: 5,
      steps: [
        'doc-researcher',
        'doc-outliner',
        'doc-interviewer',
        'doc-writer',
        { kind: 'doc-reviewer', gate: true },
        'doc-finalizer',
        'doc-quality',
        'conflicts',
        'ci',
        'merger',
      ],
    }),
    {
      // A lean document pipeline for a small / low-stakes doc: draft, auto-review loop, the
      // deterministic doc-quality gate, then the standard mergeability / CI / merge tail — so
      // even a quick doc can't merge over a conflict, a red build, or a malformed document,
      // just without the research / outline / finalize stages and their human gates.
      id: 'pl_document_quick',
      name: 'Quick document',
      purpose: 'document',
      description:
        'A lean document build for a small or low-stakes doc: draft, auto-review, the structural quality gate, then gate on conflicts + CI and merge.',
      version: 4,
      agentKinds: ['doc-writer', 'doc-reviewer', 'doc-quality', 'conflicts', 'ci', 'merger'],
    },
    // The Documentation-refresh pilot's two lean spawn pipelines (initiative-presets slice 7).
    // Each drives a single authoring step through the standard mergeability / CI / merge tail, so
    // the produced comment / doc change can't merge over a conflict or a red build. The
    // docs-refresh preset (slice 8) spawns tasks onto these; they are also pickable standalone.
    // (Diagrams + READMEs reuse `doc-writer` / `pl_document_quick` — a Mermaid `.md` is just a
    // document a writer produces — so only the in-place comment annotator gets a new kind/pipeline.)
    {
      // Add/clarify why-not-what in-source comments with NO behaviour change: `code-commenter`
      // edits only comments and (with no prior PR on a standalone run) opens one; the `ci` step is
      // load-bearing here — it proves the diff is behaviour-neutral before `merger` ships it.
      id: 'pl_code_comments',
      name: 'Improve code comments',
      purpose: 'build',
      version: 3,
      description:
        'Add or clarify why-not-what in-source comments with no behaviour change, prove the diff is behaviour-neutral on CI, then merge.',
      agentKinds: ['code-commenter', 'conflicts', 'ci', 'merger'],
    },
    {
      // Capture the service's business rules / domain constraints as in-repo docs: the reverse-
      // documentation `business-documenter` reads the implementation, commits the docs and opens
      // a PR; `conflicts`/`ci`/`merger` gate + ship it. A lean alternative to folding the
      // documenter into a full build pipeline when only the domain-rules docs are wanted.
      id: 'pl_business_docs',
      name: 'Document business rules',
      purpose: 'document',
      version: 3,
      description:
        'Read the implementation and capture the service business rules / domain constraints as in-repo docs, then gate on conflicts + CI and ship the PR.',
      agentKinds: ['business-documenter', 'conflicts', 'ci', 'merger'],
    },
  ]
}

/**
 * Built-in pipelines WITHDRAWN from the catalog: a pipeline that is no longer relevant (superseded
 * by a better preset, or built on a flow that no longer exists) is deleted from the builders above
 * and named HERE instead. The tombstone is what makes the removal reach a workspace that was
 * already seeded with it: `PipelineService.remove` accepts a built-in named here (and only one
 * named here), and the SPA's pipeline-health advisory offers it as a "retired — remove it" row.
 *
 * A tombstone is REQUIRED because absence from the catalog cannot mean retirement. `seedPipelines`
 * takes a {@link PipelineRegistry}, so the live catalog is a different set depending on whether a
 * deployment's own pipeline package is wired — treating "not in the catalog" as "retired" would
 * offer to delete a deployment's pipelines every time its registry was unwired. Retirement is
 * therefore only ever a POSITIVE assertion.
 *
 * To retire one, delete its definition from the builder above and add its id here with a comment
 * saying why; point `replacedBy` at the preset that supersedes it when one does, so the advisory can
 * name the replacement. A deployment retires its OWN registered pipelines through
 * {@link PipelineRegistry.retire}.
 */
function buildRetiredPipelines(): RetiredPipeline[] {
  return [
    // The catalog collapse (docs/initiatives/pipeline-catalog-collapse.md). All six were the SAME
    // spine as the build ladder — `coder → [reviewer] → [blueprints] → [mocker] → deployer →
    // tester → conflicts → ci → [human gate] → merger` — differing by at most two toggles, which
    // is not an axis anyone picks a pipeline on: `pl_quick` differed from `pl_simple` by
    // reviewer-vs-blueprints. The ladder now varies the one axis that matters (how much design a
    // task gets), so these have nothing left to vary.
    //
    // Every step they carried is still reachable — as a rung of the ladder, an estimate-gated step
    // of `pl_full` (`human-review`), or an opt-in step in the builder (`blueprints`, `mocker`, the
    // spec / research / docs phases) — so retiring them removes presets, not capability.

    // Differed from `pl_simple` by reviewer-vs-blueprints, which is not a choice: a code review is
    // the cheapest defect-catching step in a run and a service-map refresh is not.
    { id: 'pl_quick', replacedBy: 'pl_simple' },
    // Every optional step switched on at once. That is a saved workspace preset (clone a rung and
    // enable them), not something the product should ship and version.
    { id: 'pl_fullstack', replacedBy: 'pl_full' },
    // The build tail under a recurring-preset name. `replacedBy` points at the trivial rung because
    // a version bump is exactly its use case — it is the advisory's RECOMMENDATION for a board still
    // holding the retired row, not a claim about what any schedule runs: a schedule runs whichever
    // pipeline its author picks, and the recurring modal offers the whole schedulable set.
    { id: 'pl_dep_update', replacedBy: 'pl_simple' },
    // Each was a build plus ONE human checkpoint. `human-review` is now a risk-gated step of
    // `pl_full`, so escalation happens when the estimate says it should rather than when someone
    // remembered to pick a different pipeline; `human-test` remains a builder toggle.
    { id: 'pl_pr_review', replacedBy: 'pl_full' },
    { id: 'pl_human_review', replacedBy: 'pl_full' },
    // Retired rather than folded in, because its shape was unsafe: with no `merger` step
    // `runOpensPr` is false, so the `integrator` — a coder-class agent — committed STRAIGHT to the
    // base branch with no conflicts check and no CI. Wiring an existing change into its
    // surroundings is the `coder`'s job on a ladder rung, which gates and merges properly.
    { id: 'pl_integrate', replacedBy: 'pl_build' },
  ]
}

/**
 * A built-in pipeline that has been withdrawn from the catalog. Deliberately NOT a {@link Pipeline}:
 * a retired pipeline has no definition left to carry (its steps were deleted with it), it is never
 * seeded or persisted, and keeping it out of the stored/wire entity type is what stops a tombstone
 * from ever being mistaken for something runnable.
 */
export interface RetiredPipeline {
  /** The withdrawn built-in's catalog id — the id a already-seeded workspace still stores. */
  id: string
  /**
   * The catalog id that supersedes it, when one does. Carries no prose: the SPA names the
   * replacement pipeline and writes the sentence in the user's language (the backend does not
   * localize copy), so the WHY of a retirement lives in a comment beside its entry above.
   */
  replacedBy?: string
}

/**
 * Reusable pipelines shown in the pipeline palette on first load: the built-in catalog plus any
 * pipelines a deployment registered on the app-owned {@link PipelineRegistry} (e.g. a proprietary
 * org package), merged by id. Omit `registry` (or pass a fresh one) for the built-in catalog only —
 * the shape a caller that only resolves a BUILT-IN pipeline's id needs (e.g. plan-helpers, the
 * cross-runtime conformance baseline). The workspace + pipeline services thread the app-owned
 * instance so a deployment's custom pipelines are seeded into every new workspace.
 *
 * There is deliberately NO retirement filter here, and that is the whole reason retirement costs
 * nothing at the ~40 call sites: a retired built-in is one whose DEFINITION was deleted from the
 * builders above, so it is already absent from what this returns. The tombstone in
 * {@link buildRetiredPipelines} is a second, independent assertion — it says "this id used to be
 * ours and is now obsolete", which is knowledge no filter over the live catalog could reconstruct.
 * Retiring a built-in is therefore TWO edits, and `retiredPipelines` drops a tombstone whose
 * definition is still present rather than papering over a half-done one (a kernel unit test and the
 * `retirement_of_live_pipeline` boot check both catch that state).
 */
export function seedPipelines(registry?: PipelineRegistry): Pipeline[] {
  const builtins: Pipeline[] = [
    ...buildDeliveryPipelines(),
    ...buildBuildVariantPipelines(),
    ...buildSpecialtyPipelines(),
  ]
  // Every curated catalog pipeline is a read-only template: it can be cloned into an
  // editable copy but not edited in place (see PipelineService.update / clone). Each carries
  // a monotonic `version` (default 1) so a workspace's persisted copy can be compared against
  // the current catalog and offered a reseed when this definition moves ahead. To ship a new
  // version of a built-in, bump that pipeline's own `version` here (an explicit `version: N`
  // on the object overrides this default) — that increment is the signal the app's reseed
  // prompt keys off. The default is applied to EVERY built-in in the merged catalog — including
  // ones contributed via the pipeline registry — so a registered built-in is version-tracked +
  // reseedable too, while custom (non-built-in) registered pipelines stay versionless.
  const tagged = builtins.map((p) => ({ ...p, builtin: true }))
  const merged = registry ? registry.merge(tagged) : tagged
  return merged.map((p) => (p.builtin ? { ...p, version: p.version ?? 1 } : p))
}

/**
 * The built-in pipelines withdrawn from the catalog — the tombstones a workspace seeded before the
 * withdrawal can act on ({@link buildRetiredPipelines}, plus anything a deployment retired on its
 * own {@link PipelineRegistry}).
 *
 * A LIVE pipeline always wins: an id that {@link seedPipelines} still yields is filtered out here,
 * so a deployment that registers a pipeline under an id we retired keeps its pipeline instead of
 * being offered a delete for it. That also makes the two sets disjoint by construction, so no
 * caller has to decide which of "reseed it" and "remove it" applies.
 */
export function retiredPipelines(registry?: PipelineRegistry): RetiredPipeline[] {
  const builtins = buildRetiredPipelines()
  const merged = registry ? registry.mergeRetired(builtins) : builtins
  // Nothing to filter ⇒ don't rebuild the catalog. This is the case on EVERY deployment that has
  // retired nothing (including, today, the built-in list), and it sits on `WorkspaceService.
  // snapshot()` — the board-load path, which already builds the catalog once for
  // `pipelineCatalogVersions`. Without this the feature doubles that work forever to filter an
  // empty list.
  if (merged.length === 0) return merged
  const live = new Set(seedPipelines(registry).map((p) => p.id))
  return merged.filter((p) => !live.has(p.id))
}

/** Pipeline id of the blueprint-only run kicked off after a successful bootstrap. */
export const BLUEPRINT_PIPELINE_ID = 'pl_blueprint'

/** Pipeline id of the Initiative Planning pipeline (initiative blocks only). */
export const INITIATIVE_PIPELINE_ID = 'pl_initiative'

/**
 * Pipeline id of the Documentation-refresh preset's planning pipeline (initiative-presets slice 8):
 * `pl_initiative` minus the interviewer + human gates. The `preset_docs_refresh` descriptor binds it
 * as its `planningPipelineId`.
 */
export const INITIATIVE_DOCS_PIPELINE_ID = 'pl_initiative_docs'

/**
 * Pipeline ids of the Documentation-refresh pilot's lean spawn pipelines (initiative-presets
 * slice 7). The docs-refresh preset (slice 8) stamps these onto the tasks its planner spawns
 * (in-source comments / business rules); diagrams + READMEs reuse `pl_document_quick`.
 */
export const CODE_COMMENTS_PIPELINE_ID = 'pl_code_comments'
export const BUSINESS_DOCS_PIPELINE_ID = 'pl_business_docs'

/**
 * Pipeline id of the full document-authoring pipeline (`doc-researcher` → `doc-outliner` →
 * `doc-interviewer` → `doc-writer` → auto-review → `doc-finalizer` → `doc-quality` → the
 * mergeability / CI / merge tail). This is the DEFAULT pipeline a `taskType: 'document'` task is
 * pinned to at creation ({@link defaultPipelineIdForTaskType}) — the full-build pipeline makes no
 * sense for a document (no code / spec / tests).
 */
export const DOCUMENT_PIPELINE_ID = 'pl_document'

/**
 * Pipeline id of the spike pipeline (`requirements-review`(off) → `spike` → `conflicts` → `ci` →
 * `human-review` → `merger`). This is the DEFAULT pipeline a `taskType: 'spike'` task is pinned to
 * at creation ({@link defaultPipelineIdForTaskType}) — the full-build pipeline makes no sense for a
 * timeboxed research task. The findings are delivered as a PULL REQUEST that the review/merge tail
 * lands, so protected base branches are respected.
 */
export const SPIKE_PIPELINE_ID = 'pl_spike'

// The direct-commit spike pipeline (`requirements-review`(off) → `spike`) is `pl_spike_direct`
// (defined above) — the fast no-PR path for unprotected repos, opt-in (not the type default). It
// has no exported id constant because nothing resolves it programmatically; the type default
// resolves `SPIKE_PIPELINE_ID` and a user selects the direct variant by pipeline id in the UI.

/**
 * Pipeline id of the lean document pipeline (`doc-writer` → auto-review → `doc-quality` → the
 * mergeability / CI / merge tail). The docs-refresh preset (slice 8) spawns README + diagram tasks
 * onto it.
 */
export const DOCUMENT_QUICK_PIPELINE_ID = 'pl_document_quick'

/**
 * Pipeline id of the PR deep-review pipeline (`pr-reviewer`). The DEFAULT pipeline a
 * `taskType: 'review'` task is pinned to at creation ({@link defaultPipelineIdForTaskType}) — the
 * full-build pipeline makes no sense for a review (no code / spec / tests, no PR opened).
 */
export const REVIEW_PIPELINE_ID = 'pl_review'

/** Pipeline id of the Ralph loop (a persistent retry-until-done build; see backend/docs/ralph-loop.md). */
export const RALPH_PIPELINE_ID = 'pl_ralph'

/**
 * The pipeline a task of the given task type should default to when the creator pins none.
 * `document` → `pl_document`, `spike` → `pl_spike`, and `review` → `pl_review` (the full-build
 * `pl_full` is wrong for all three — a document has no code, a spike has no code, a review opens
 * no PR); every other BUILT-IN task type falls through to the workspace's positional default.
 * A CUSTOM (namespaced) task type consults the injected {@link TaskTypeRegistry} AFTER the
 * built-in map, so a deployment-registered type can pin its own default pipeline. Returns
 * `undefined` when there is no type-specific default, so the caller leaves `pipelineId` unset.
 */
export function defaultPipelineIdForTaskType(
  taskType: Block['taskType'],
  taskTypeRegistry?: TaskTypeRegistry,
): string | undefined {
  if (taskType === 'document') return DOCUMENT_PIPELINE_ID
  if (taskType === 'spike') return SPIKE_PIPELINE_ID
  if (taskType === 'review') return REVIEW_PIPELINE_ID
  if (taskType === 'ralph') return RALPH_PIPELINE_ID
  if (taskType && taskTypeRegistry) return taskTypeRegistry.defaultPipelineId(taskType)
  return undefined
}

/** Pipeline id of the built-in recurring tech-debt preset. */
export const TECH_DEBT_PIPELINE_ID = 'pl_tech_debt'
/** Pipeline id of the recurring bug-triage pipeline (backlog worker; see backend/docs/bug-triage-pipeline.md). */
export const BUG_TRIAGE_PIPELINE_ID = 'pl_bug_triage'
/**
 * Pipeline id of the one-off bug-fix preset (investigate → triage → fix → ship). This is the
 * default an adopted bug-hunt candidate runs, so the interactive hunt lands on the same
 * investigate/clarify path the recurring triage pipeline uses — see backend/docs/bug-hunt.md.
 */
export const BUGFIX_PIPELINE_ID = 'pl_bugfix'

// ---- The build ladder's three rungs -------------------------------------------------------
// The axis is how much design a task gets. `pl_build` is the DEFAULT and must stay first in
// `buildDeliveryPipelines`, because `seedPipelines()[0]` is the positional default a plain "Start"
// resolves. A caller that needs "the ordinary build pipeline" programmatically should name
// `BUILD_PIPELINE_ID` rather than re-deriving it from catalog order.

/**
 * Pipeline id of the DEFAULT build pipeline: `architect` → `architect-companion` → `coder` →
 * `reviewer` → `deployer` → `tester-api` → `conflicts` → `ci` → `merger`, every step
 * unconditional. The everyday programmatic loop.
 */
export const BUILD_PIPELINE_ID = 'pl_build'

/**
 * Pipeline id of the TRIVIAL rung — {@link BUILD_PIPELINE_ID} minus the design phase, for work
 * whose approach is not in question (a copy fix, a version bump, a one-line guard).
 */
export const SIMPLE_PIPELINE_ID = 'pl_simple'

/**
 * Pipeline id of the ADAPTIVE rung, which runs a `task-estimator` first and estimate-gates its own
 * `architect` / `tester-api` / `human-review` steps — the `pl_simple`-vs-`pl_build` choice made per
 * task rather than per service.
 */
export const ADAPTIVE_BUILD_PIPELINE_ID = 'pl_full'
