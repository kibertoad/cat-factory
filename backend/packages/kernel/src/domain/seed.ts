import type { PipelineRegistry } from './pipeline-registry.js'
import type { TaskTypeRegistry } from './task-type-registry.js'
import type { Block, Pipeline } from './types.js'

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
 * gate; the object form NAMES the step's human `gate` (approval pause) and/or marks it opt-in
 * (`enabled: false` — present in the preset but disabled by default). This replaces the fragile
 * index-aligned `gates`/`enabled` boolean arrays: a gate is declared BY NAME on its own step, so
 * inserting a step (e.g. a `deployer` before the tester) can never shift a positional flag onto the
 * wrong step. `gate` is intentionally the extension seam — a custom gate can carry its own config
 * here (see the ambient-augmentation note in docs/initiatives/deployer-single-provisioner.md).
 */
type SeedStep = string | { kind: string; gate?: boolean; enabled?: boolean }

/**
 * Lower a named-step pipeline spec into the wire {@link Pipeline} (index-aligned
 * `agentKinds`/`gates`/`enabled`). `gates`/`enabled` are emitted ONLY when a step actually declares
 * a human gate / is disabled by default, so a plain all-enabled, gate-less pipeline stays as bare
 * `agentKinds` — its persisted shape is byte-identical to the hand-authored form.
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
  const gates = norm.map((s) => s.gate === true)
  const enabled = norm.map((s) => s.enabled !== false)
  return {
    id: spec.id,
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    agentKinds: norm.map((s) => s.kind),
    ...(gates.some(Boolean) ? { gates } : {}),
    ...(enabled.some((e) => !e) ? { enabled } : {}),
    ...(spec.availability ? { availability: spec.availability } : {}),
    ...(spec.purpose ? { purpose: spec.purpose } : {}),
    ...(spec.labels ? { labels: spec.labels } : {}),
    ...(spec.version !== undefined ? { version: spec.version } : {}),
    ...(spec.public ? { public: spec.public } : {}),
  } as Pipeline
}

/**
 * Reusable pipelines shown in the pipeline palette on first load: the built-in catalog plus any
 * pipelines a deployment registered on the app-owned {@link PipelineRegistry} (e.g. a proprietary
 * org package), merged by id. Omit `registry` (or pass a fresh one) for the built-in catalog only —
 * the shape a caller that only resolves a BUILT-IN pipeline's id needs (e.g. plan-helpers, the
 * cross-runtime conformance baseline). The workspace + pipeline services thread the app-owned
 * instance so a deployment's custom pipelines are seeded into every new workspace.
 */
export function seedPipelines(registry?: PipelineRegistry): Pipeline[] {
  const builtins: Pipeline[] = [
    // `requirements` runs first and reviews the collected requirements; the spec-writer then
    // applies them as an increment onto the in-repo spec baseline, and only THEN does the architect
    // design the solution against that written spec (the architect is spec-aware). The requirements
    // review + the architecture pause for human approval (`gate: true`); the spec is NOT human-gated
    // — its `spec-companion` rates it and loops the spec-writer back automatically. `blueprints`
    // refreshes the service map from the new code; a `deployer` stands a kubernetes/custom env up
    // for the tester (a no-op otherwise); `conflicts`/`ci`/`merger` gate + ship the PR. The two
    // brainstorm dialogues are opt-in (`enabled: false`). Version bumped for the deployer reseed.
    definePipeline({
      id: 'pl_full',
      name: 'Full build',
      purpose: 'build',
      description:
        'The standard end-to-end build: review the requirements, write the spec, design the solution, implement and review it, refresh the service map, test, then gate on conflicts + CI and merge the PR.',
      // `code-commenter` runs after the reviewer clears the implementation: it amends the coder's
      // PR in place with comment-only edits (WHY-not-what, fixes drifted comments, drops noise), so
      // basic comment hygiene is business-as-usual on every task. `ci` re-runs to prove the
      // comment-only diff is behaviour-neutral. Version bumped for the code-commenter reseed,
      // then again for the pipeline-description reseed, then again for the purpose classifier reseed.
      version: 5,
      steps: [
        // Opt-in structured-dialogue option exploration before the requirements review.
        { kind: 'requirements-brainstorm', gate: true, enabled: false },
        { kind: 'requirements-review', gate: true },
        'spec-writer',
        'spec-companion',
        // Opt-in structured-dialogue approach exploration before the architect.
        { kind: 'architecture-brainstorm', gate: true, enabled: false },
        { kind: 'architect', gate: true },
        'researcher',
        'coder',
        'reviewer',
        'code-commenter',
        'blueprints',
        'mocker',
        'deployer',
        'tester-api',
        'conflicts',
        'ci',
        'merger',
      ],
    }),
    definePipeline({
      // The most thorough preset: a complex, full-stack feature run that engages
      // every valuable agent so no angle is left uncovered. It extends "Full build"
      // with the up-front researcher, the acceptance-scenario author, the external-
      // dependency mock builder, the business-logic documenter and the developer
      // documenter, in addition to the runnable end-to-end (`playwright`) tests:
      //
      //   requirements-review → analyse + clarify the collected context (human gate)
      //   researcher          → investigate prior art, libraries and constraints
      //   spec-writer         → apply this task's clarified requirements as a spec
      //                         increment (+ acceptance scenarios) onto the baseline
      //                         on the work branch BEFORE the design/code
      //   spec-companion      → challenge acceptance-scenario coverage; loop the
      //                         spec-writer back below threshold (no human gate)
      //   architect           → design the solution against the written spec
      //   architect-companion → challenge the design's quality; loop back below
      //                         threshold, then raise the human gate on a pass
      //   mocker        → stand up mocks for the external dependencies
      //   coder         → implement the feature on the implementation branch
      //   reviewer      → coder's companion: rate the change immediately, loop back
      //                   for rework before the map/test tail runs
      //   code-commenter→ bring the changed code's in-source comments up to standard
      //                   (why-not-what, fix drift, drop noise) on the same PR
      //   blueprints    → refresh the in-repo service map from the new code
      //   business-documenter → capture the domain rules the code now encodes
      //   tester        → define the unit / integration test strategy
      //   playwright    → author the runnable end-to-end / acceptance TESTS (from the
      //                   spec's derived Gherkin)
      //   documenter    → write the developer-facing documentation
      //   conflicts → ci → merger → the same mergeability / CI / merge tail as Full build
      id: 'pl_fullstack',
      name: 'Complex fullstack feature',
      purpose: 'build',
      description:
        'The most thorough preset — engages every valuable agent (research, spec, design, mocks, end-to-end tests and docs) for a complex, full-stack feature, then gates and ships the PR.',
      // A `deployer` runs before the tester (k8s/custom only; a no-op otherwise). Human gates: the
      // two opt-in brainstorm dialogues, the requirements review, and — after its companion clears
      // the quality bar — the architecture (on `architect-companion`). A `code-commenter` runs after
      // the reviewer to keep in-source comments up to standard on the same PR. Version bumped for
      // the code-commenter reseed, then again for the pipeline-description reseed, then again for the purpose classifier reseed.
      version: 5,
      steps: [
        // Opt-in structured-dialogue option exploration.
        { kind: 'requirements-brainstorm', gate: true, enabled: false },
        { kind: 'requirements-review', gate: true },
        'researcher',
        'spec-writer',
        'spec-companion',
        // Opt-in structured-dialogue approach exploration.
        { kind: 'architecture-brainstorm', gate: true, enabled: false },
        'architect',
        { kind: 'architect-companion', gate: true },
        'mocker',
        'coder',
        'reviewer',
        'code-commenter',
        'blueprints',
        'business-documenter',
        'deployer',
        'tester-api',
        'playwright',
        'documenter',
        'conflicts',
        'ci',
        'merger',
      ],
    }),
    // A bug-fix preset, front-loaded with the investigate → triage pair: `bug-investigator` reads
    // the codebase from the raw report (read-only) and emits an enriched report; `clarity-review`
    // triages it for fixability (the ONLY human gate — the iterative answer → incorporate → re-review
    // loop); `spec-writer` folds the clarified brief into the spec; architect → coder → reviewer is
    // the core; conflicts → ci → merger is the standard tail.
    definePipeline({
      id: 'pl_bugfix',
      name: 'Triage & fix bug',
      purpose: 'build',
      version: 3,
      description:
        'Investigate a bug report against the codebase, triage it for fixability with you, then fix, review, and ship the PR.',
      steps: [
        'bug-investigator',
        { kind: 'clarity-review', gate: true },
        'spec-writer',
        'architect',
        'coder',
        'reviewer',
        'conflicts',
        'ci',
        'merger',
      ],
    }),
    {
      id: 'pl_quick',
      name: 'Quick implement',
      purpose: 'build',
      description:
        'A fast build with no design or spec phase: implement, refresh the map, mock and test, then gate on conflicts + CI and merge.',
      // A `deployer` runs before the tester so a kubernetes/custom service gets its ephemeral env
      // stood up (a no-op for docker-compose/infraless/frontend); bump the version for the reseed
      // offer. Same pattern across every tester/human-test built-in below. Bumped again for the
      // pipeline-description reseed, then again for the purpose classifier reseed.
      version: 4,
      agentKinds: [
        'coder',
        'blueprints',
        'mocker',
        'deployer',
        'tester-api',
        'conflicts',
        'ci',
        'merger',
      ],
    },
    // The leanest end-to-end build: implement → review → test, then the standard
    // mergeability / CI / merge tail. The `coder` (Implementer) writes the change,
    // its `reviewer` companion rates it immediately and loops it back for automatic
    // rework below threshold, `mocker` stands up the external-dependency mocks the
    // `tester` needs to run the suite, and `conflicts` / `ci` / `merger` gate and
    // ship the PR — no design, spec or docs phases.
    {
      id: 'pl_simple',
      name: 'Simple',
      purpose: 'build',
      description:
        'The leanest build: implement and review, run the tests, then gate on conflicts + CI and merge — no design, spec, or docs.',
      version: 4,
      agentKinds: [
        'coder',
        'reviewer',
        'mocker',
        'deployer',
        'tester-api',
        'conflicts',
        'ci',
        'merger',
      ],
    },
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
    {
      id: 'pl_integrate',
      name: 'Integrate & ship',
      purpose: 'build',
      description:
        'Wire an existing change into the surrounding system, mock and test it, then document it.',
      version: 4,
      agentKinds: ['integrator', 'mocker', 'deployer', 'tester-api', 'documenter'],
    },
    // A human-in-the-loop build: implement → review, then a `human-test` gate that spins up an
    // ephemeral environment and PARKS for a person to validate the change in a live URL before
    // the standard mergeability / CI / merge tail. From the gate the human can request a fix
    // (the Tester's `fixer`), pull main into the branch (the `conflict-resolver` on a conflict),
    // or destroy/recreate the env. Opt-in — it requires a human present and (ideally) an
    // ephemeral-environment provider, so it is NOT folded into the always-on default pipelines.
    {
      id: 'pl_human_review',
      name: 'Build & human-test',
      purpose: 'build',
      description:
        'Implement and review, then pause on a live ephemeral environment for a person to validate the change before gating on conflicts + CI and merging.',
      // The `deployer` stands the ephemeral env up before the human-test gate reads it (the gate no
      // longer provisions its own — the deployer is the single provisioner; the gate loops back here
      // to rebuild on a fix/recreate). Bumped again for the pipeline-description reseed, then again for the purpose classifier reseed.
      version: 4,
      agentKinds: ['coder', 'reviewer', 'deployer', 'human-test', 'conflicts', 'ci', 'merger'],
    },
    // A human-code-review build: the full implement → review → map → test tail, then a
    // `human-review` gate that watches the PR for a human reviewer on GitHub before `merger`
    // ships it. The gate advances once the PR meets GitHub's required approvals with no
    // unresolved review threads; otherwise it loops the `fixer` to address the reviewer's
    // comments (after a grace period when not yet approved) and waits indefinitely for the
    // human. Opt-in — it requires a real reviewer (and a wired PR-review provider), so it is
    // NOT folded into the always-on default pipelines; it is a pass-through when unwired.
    {
      id: 'pl_pr_review',
      name: 'Build & PR review',
      purpose: 'build',
      description:
        'The full implement → review → test build, then wait for a human code review on the PR — looping a fixer on comments — before merging.',
      version: 4,
      agentKinds: [
        'coder',
        'reviewer',
        'blueprints',
        'mocker',
        'deployer',
        'tester-api',
        'conflicts',
        'ci',
        'human-review',
        'merger',
      ],
    },
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
      version: 4,
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
      version: 4,
      agentKinds: [
        'coder',
        'reviewer',
        'mocker',
        'deployer',
        'tester-ui',
        'conflicts',
        'ci',
        'merger',
      ],
    },
    // Recurring-pipeline presets. "Dependency updates" is a plain implement →
    // review → merge run; "Tech debt" first runs a read-only `analysis` agent and
    // a special `tracker` step (files a GitHub issue / Jira ticket from the
    // analysis) before implementation. Both are picked when creating a recurring
    // pipeline on a service.
    {
      id: 'pl_dep_update',
      name: 'Dependency updates',
      purpose: 'build',
      description:
        'A recurring implement → review → test → merge run for keeping a repository up to date on its dependencies.',
      version: 4,
      agentKinds: [
        'coder',
        'reviewer',
        'blueprints',
        'mocker',
        'deployer',
        'tester-api',
        'conflicts',
        'ci',
        'merger',
      ],
    },
    {
      id: 'pl_tech_debt',
      name: 'Tech debt',
      purpose: 'build',
      description:
        'Audit the repository, file a tracker ticket from the findings, then implement, test, and ship the fix.',
      version: 4,
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
        'A recurring run that pulls one open issue from your tracker board, investigates and clarifies it, then fixes, tests, and ships the PR.',
      availability: 'recurring',
      // A `deployer` runs before the tester (k8s/custom only; a no-op otherwise). Only
      // `clarity-review` is a human gate; version bumped for the reseed offer, then again for the
      // pipeline-description reseed, then again for the purpose classifier reseed.
      version: 4,
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
      // engine's runnable guard). The INTERVIEWER interviews the human on goals /
      // constraints (an inline park/answer/resume gate driven by its own controller,
      // NOT a `gates[]` human gate — hence `false` at its index); the ANALYST reads
      // the repo and writes a codebase analysis; the PLANNER — grounded in both —
      // emits the multi-phase plan as structured output; the HUMAN GATE after it
      // (index 2) holds the run until the plan is approved; the committer then persists
      // the plan (the `initiatives` entity + the in-repo tracker under
      // `docs/initiatives/<slug>/`) and arms the execution loop.
      id: 'pl_initiative',
      name: 'Plan initiative',
      purpose: 'planning',
      description:
        'Interview you on the initiative, analyze the codebase, and draft a multi-phase plan for approval before committing it.',
      // Slice 2 added the interviewer + analyst in front of the planner; version bumped for the
      // reseed offer. The interviewer parks via its own controller (not a `gate`); the only human
      // gate is on the planner's output, before the committer persists it. Bumped again for the
      // pipeline-description reseed, then again for the purpose classifier reseed.
      version: 4,
      steps: [
        'initiative-interviewer',
        'initiative-analyst',
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
    // external callers via `POST /api/v1/initiatives`; being inline (no container / no repo)
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

/** Pipeline ids of the built-in recurring-pipeline presets. */
export const DEP_UPDATE_PIPELINE_ID = 'pl_dep_update'
export const TECH_DEBT_PIPELINE_ID = 'pl_tech_debt'
/** Pipeline id of the recurring bug-triage pipeline (backlog worker; see backend/docs/bug-triage-pipeline.md). */
export const BUG_TRIAGE_PIPELINE_ID = 'pl_bug_triage'
