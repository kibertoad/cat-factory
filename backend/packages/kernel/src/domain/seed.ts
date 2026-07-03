import { mergeRegisteredPipelines } from './pipeline-registry.js'
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
 * Reusable pipelines shown in the pipeline palette on first load: the built-in catalog
 * plus any pipelines a deployment registered via `registerPipeline` (e.g. a proprietary
 * org package), merged by id.
 */
export function seedPipelines(): Pipeline[] {
  const builtins: Pipeline[] = [
    {
      id: 'pl_full',
      name: 'Full build',
      // `requirements` runs first and reviews the collected requirements; the
      // spec-writer then applies them as an increment onto the in-repo spec baseline,
      // and only THEN does the
      // architect design the solution — against that written spec (the architect is
      // spec-aware, so it reads `spec/` from its checkout). The requirements review and
      // the architecture pause for human approval (their proposals are reviewed/edited
      // before the next step); the spec is NOT human-gated — its `spec-companion`
      // (Spec Reviewer) rates it and loops the spec-writer back automatically instead.
      // `blueprints` runs right after implementation so the service map (and the board)
      // is refreshed from the just-written code, on the same PR branch. `conflicts`
      // then ensures the PR is mergeable with its base — looping a `conflict-resolver`
      // agent to merge the base in and resolve any conflicts — `ci` gates the
      // (now-final, up-to-date) PR branch on green CI — looping a `ci-fixer` agent on
      // failure — and `merger` runs last: it scores the PR and either auto-merges
      // (within the task's thresholds) or raises a review notification.
      agentKinds: [
        // Structured-dialogue option exploration BEFORE the requirements review (opt-in:
        // disabled by default in `enabled` below). Turns a vague description into a crisp
        // requirements direction the review then critiques.
        'requirements-brainstorm',
        'requirements-review',
        // The spec-writer applies THIS task's clarified requirements as an increment
        // onto the spec already committed at the branch's baseline (what's merged so
        // far), writing the complete updated in-repo `spec/` document onto the work
        // branch BEFORE the architect and coder run — so the spec (and its Gherkin
        // acceptance scenarios) is the source of truth the architect designs against
        // and the code is written to satisfy. An unmerged sibling task's work is never
        // visible: the only inputs are this task's requirements and the baseline. It
        // is NOT human-gated: the `spec-companion` (Spec Reviewer) below rates the
        // spec and loops the spec-writer back for automatic rework below threshold.
        'spec-writer',
        // `spec-companion` is the spec-writer's optional reviewer: it grades the
        // spec (especially acceptance-scenario coverage), and below its threshold
        // loops the spec-writer back with the feedback folded in — replacing the
        // human review the spec used to require.
        'spec-companion',
        // Structured-dialogue approach exploration BEFORE the architect (opt-in: disabled by
        // default in `enabled` below). Starts from the refined requirements and finalizes an
        // approach the architect designs against.
        'architecture-brainstorm',
        'architect',
        'researcher',
        'coder',
        // `reviewer` is the coder's companion: it rates the change IMMEDIATELY after
        // implementation and loops the coder back for automatic rework when quality is
        // below threshold (see companions) — so review + rework happen before the
        // map/test tail runs, on already-reviewed code.
        'reviewer',
        'blueprints',
        // `mocker` stands up the external-dependency mocks the tester needs to run
        // the suite locally, so it always runs immediately before `tester`.
        'mocker',
        'tester-api',
        'conflicts',
        'ci',
        'merger',
      ],
      // Human gates: the two opt-in brainstorm dialogues (indices 0 + 4), the context
      // requirements review (index 1) and the architecture proposal (`architect`, index 5).
      // The spec is NOT human-gated — its `spec-companion` (index 3) is the quality gate. The
      // `mocker` / `tester` / `conflicts` / `ci` / `merger` tail gates/decides itself.
      gates: [
        true,
        true,
        false,
        false,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ],
      // The two brainstorm steps are opt-in: present in the preset but DISABLED by default
      // (indices 0 = requirements-brainstorm, 4 = architecture-brainstorm), so they are
      // skipped at run start unless a user toggles them on for the pipeline. Every other
      // step is enabled.
      enabled: [
        false,
        true,
        true,
        true,
        false,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ],
    },
    {
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
      //   blueprints    → refresh the in-repo service map from the new code
      //   business-documenter → capture the domain rules the code now encodes
      //   tester        → define the unit / integration test strategy
      //   playwright    → author the runnable end-to-end / acceptance TESTS (from the
      //                   spec's derived Gherkin)
      //   documenter    → write the developer-facing documentation
      //   conflicts → ci → merger → the same mergeability / CI / merge tail as Full build
      id: 'pl_fullstack',
      name: 'Complex fullstack feature',
      agentKinds: [
        // Opt-in structured-dialogue option exploration (disabled by default in `enabled`).
        'requirements-brainstorm',
        'requirements-review',
        'researcher',
        'spec-writer',
        'spec-companion',
        // Opt-in structured-dialogue approach exploration (disabled by default in `enabled`).
        'architecture-brainstorm',
        'architect',
        'architect-companion',
        'mocker',
        'coder',
        'reviewer',
        'blueprints',
        'business-documenter',
        'tester-api',
        'playwright',
        'documenter',
        'conflicts',
        'ci',
        'merger',
      ],
      // Human gates: the two opt-in brainstorm dialogues (indices 0 + 5), the context
      // requirements review (index 1) and — after its companion has cleared the quality bar —
      // the architecture (on `architect-companion`, index 7). The spec is NOT human-gated: its
      // `spec-companion` (index 4) rates it and loops the spec-writer back automatically. Every
      // other step (including the self-gating conflicts / ci / merger tail and the auto-only
      // `reviewer` companion) runs straight through.
      gates: [
        true,
        true,
        false,
        false,
        false,
        true,
        false,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ],
      // The two brainstorm steps are opt-in: present but DISABLED by default (indices 0 =
      // requirements-brainstorm, 5 = architecture-brainstorm), skipped at run start unless a
      // user toggles them on for the pipeline. Every other step is enabled.
      enabled: [
        false,
        true,
        true,
        true,
        true,
        false,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ],
    },
    {
      // A bug-fix preset, front-loaded with the investigate → triage pair:
      //   bug-investigator → read the codebase from the raw report (read-only) and emit an
      //                      enriched report + an optional, confidence-gated hypothesis
      //   clarity-review   → triage that report for fixability (human gate; the iterative
      //                      answer → incorporate → re-review loop), producing the clarified
      //                      brief downstream agents consume
      //   spec-writer      → fold the clarified brief into the in-repo spec
      //   architect → coder → reviewer → the design/implement/review core
      //   conflicts → ci → merger → the standard mergeability / CI / merge tail
      // Only the clarity review is a human gate; the read-only investigator auto-advances.
      id: 'pl_bugfix',
      name: 'Triage & fix bug',
      agentKinds: [
        'bug-investigator',
        'clarity-review',
        'spec-writer',
        'architect',
        'coder',
        'reviewer',
        'conflicts',
        'ci',
        'merger',
      ],
      gates: [false, true, false, false, false, false, false, false, false],
    },
    {
      id: 'pl_quick',
      name: 'Quick implement',
      agentKinds: ['coder', 'blueprints', 'mocker', 'tester-api', 'conflicts', 'ci', 'merger'],
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
      agentKinds: ['coder', 'reviewer', 'mocker', 'tester-api', 'conflicts', 'ci', 'merger'],
    },
    {
      id: 'pl_integrate',
      name: 'Integrate & ship',
      agentKinds: ['integrator', 'mocker', 'tester-api', 'documenter'],
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
      agentKinds: ['coder', 'reviewer', 'human-test', 'conflicts', 'ci', 'merger'],
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
      agentKinds: [
        'coder',
        'reviewer',
        'blueprints',
        'mocker',
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
      labels: ['experimental'],
      agentKinds: [
        'coder',
        'reviewer',
        'mocker',
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
      labels: ['experimental'],
      agentKinds: ['coder', 'reviewer', 'mocker', 'tester-ui', 'conflicts', 'ci', 'merger'],
    },
    // Recurring-pipeline presets. "Dependency updates" is a plain implement →
    // review → merge run; "Tech debt" first runs a read-only `analysis` agent and
    // a special `tracker` step (files a GitHub issue / Jira ticket from the
    // analysis) before implementation. Both are picked when creating a recurring
    // pipeline on a service.
    {
      id: 'pl_dep_update',
      name: 'Dependency updates',
      agentKinds: [
        'coder',
        'reviewer',
        'blueprints',
        'mocker',
        'tester-api',
        'conflicts',
        'ci',
        'merger',
      ],
    },
    {
      id: 'pl_tech_debt',
      name: 'Tech debt',
      agentKinds: [
        'analysis',
        'tracker',
        'coder',
        'reviewer',
        'blueprints',
        'mocker',
        'tester-api',
        'conflicts',
        'ci',
        'merger',
      ],
    },
    // A blueprint-only pipeline, run after a bootstrap to create the initial
    // service map (and populate the board) from the freshly bootstrapped repo.
    { id: 'pl_blueprint', name: 'Map service', agentKinds: ['blueprints'] },
    {
      // The Initiative Planning pipeline — the ONLY pipeline runnable on an
      // `initiative`-level block (and initiative blocks accept no other; see the
      // engine's runnable guard). The planner analyses the codebase and emits the
      // multi-phase plan as structured output; the HUMAN GATE after it holds the
      // run until the plan is approved; the committer then persists the plan (the
      // `initiatives` entity + the in-repo tracker under `docs/initiatives/<slug>/`)
      // and arms the execution loop. The interviewer/analyst steps land in a later
      // slice (see docs/initiatives/initiatives-feature.md).
      id: 'pl_initiative',
      name: 'Plan initiative',
      agentKinds: ['initiative-planner', 'initiative-committer'],
      gates: [true, false],
    },
    // A spec-only pipeline, to (re)generate a service's unified in-repo specification
    // (and its Gherkin acceptance scenarios) independently.
    { id: 'pl_spec', name: 'Write spec', agentKinds: ['spec-writer'] },
    {
      // FORWARD document authoring: turn a brief (+ linked PRDs/RFCs/issues) into a polished
      // in-repo Markdown document shipped as a PR. Unlike the reverse-documentation kinds
      // (documenter / business-documenter / blueprints) that describe existing code, this
      // produces a NEW document (PRD / RFC / design / ADR / technical reference / runbook /
      // research report — driven by the task's `docKind`).
      //
      //   doc-researcher → investigate the topic, prior art and linked context (inline)
      //   doc-outliner   → propose a kind-appropriate outline (inline) — HUMAN GATE: the
      //                    cheapest, highest-leverage checkpoint is on the structure
      //   doc-writer     → write the document as Markdown and open a PR (container-coding)
      //   doc-reviewer   → the writer's companion: rate the draft and loop it back for rework
      //                    below threshold (AI-to-AI convergence) — HUMAN GATE on the converged
      //                    draft, whose feedback the finalizer folds in via the revision context
      //   doc-finalizer  → final editorial pass on the PR branch (container-coding, no new PR)
      //   conflicts → ci → merger → the same mergeability / CI / merge tail as a code pipeline
      id: 'pl_document',
      name: 'Author a document',
      agentKinds: [
        'doc-researcher',
        'doc-outliner',
        'doc-writer',
        'doc-reviewer',
        'doc-finalizer',
        'conflicts',
        'ci',
        'merger',
      ],
      // Human gates on the outline (index 1) and on the converged review (`doc-reviewer`,
      // index 3, after its rework loop clears the bar). Everything else self-drives.
      gates: [false, true, false, true, false, false, false, false],
    },
    {
      // A lean document pipeline for a small / low-stakes doc: draft, auto-review loop, then
      // the standard mergeability / CI / merge tail — so even a quick doc can't merge over a
      // conflict or a red build, just without the research / outline / finalize stages and
      // their human gates.
      id: 'pl_document_quick',
      name: 'Quick document',
      agentKinds: ['doc-writer', 'doc-reviewer', 'conflicts', 'ci', 'merger'],
    },
  ]
  // Every curated catalog pipeline is a read-only template: it can be cloned into an
  // editable copy but not edited in place (see PipelineService.update / clone). Each carries
  // a monotonic `version` (default 1) so a workspace's persisted copy can be compared against
  // the current catalog and offered a reseed when this definition moves ahead. To ship a new
  // version of a built-in, bump that pipeline's own `version` here (an explicit `version: N`
  // on the object overrides this default) — that increment is the signal the app's reseed
  // prompt keys off. The default is applied to EVERY built-in in the merged catalog — including
  // ones contributed by `registerPipeline` — so a registered built-in is version-tracked +
  // reseedable too, while custom (non-built-in) registered pipelines stay versionless.
  return mergeRegisteredPipelines(builtins.map((p) => ({ ...p, builtin: true }))).map((p) =>
    p.builtin ? { ...p, version: p.version ?? 1 } : p,
  )
}

/** Pipeline id of the blueprint-only run kicked off after a successful bootstrap. */
export const BLUEPRINT_PIPELINE_ID = 'pl_blueprint'

/** Pipeline id of the Initiative Planning pipeline (initiative blocks only). */
export const INITIATIVE_PIPELINE_ID = 'pl_initiative'

/** Pipeline ids of the built-in recurring-pipeline presets. */
export const DEP_UPDATE_PIPELINE_ID = 'pl_dep_update'
export const TECH_DEBT_PIPELINE_ID = 'pl_tech_debt'
