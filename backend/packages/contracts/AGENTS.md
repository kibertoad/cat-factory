# `@cat-factory/contracts`: Valibot wire contracts

The dependency **leaf** (no workspace deps). Valibot schemas shared by the SPA + every backend:
the single source of truth for wire shapes and the domain vocabulary.

**Entry:** `src/index.ts`. `src/routes/` holds the per-route request/response contracts; the
top-level files are the domain contracts.

**Key files:**

- `primitives.ts`: the block **type** / **status** / **level** enums. There are two "task"
  axes: `frame → module → task → epic` is the block **level**, separate from the block **type**
  (`taskType`). See `docs/glossary.md`.
- `entities.ts`: the `Block` and other entity schemas. The canonical unit of work is a
  **block** (`task` is the tracker-boundary name, `card` the UI/events name: one thing, three
  names; `docs/glossary.md`).
- `execution.ts`: the run/step runtime state, composed from the step-state clusters that live in
  their own modules: `gate.ts` (polling gates), `human-verdict-gates.ts` (human-test, visual
  confirmation) and `step-decisions.ts` (an agent's question, review comments, a companion
  verdict, and the approval gate — which is also the engine's GENERIC parking mechanism, so a
  pending approval does NOT by itself mean "approval gate"; orchestration's
  `dedicatedParkSurface` is what tells them apart).
- `public-decisions.ts`: the external projection of every park a run can stop on, plus the bodies
  that answer them. The kind union is the surface's honesty check — a member with no route behind
  it is a promise `/api/v1` cannot keep.
- `public-merge-evidence.ts`: the external projection of a merge track record (`mergeTrackRecord.ts`),
  renaming its `blockId`/`executionId` to the `taskId`/`runId` the public surface addresses things
  by. The ROLLUPS beside it are served verbatim from that module rather than re-projected, so the
  preset editor and an integration cannot report different auto-merge shares for one workspace.
- `events.ts`: the `WorkspaceEvent` union pushed to the SPA; `errors.ts`: the `reason`/`code`
  vocabulary the SPA maps to i18n keys. Both axes are declared here: `DOMAIN_ERROR_CODES` /
  `API_ERROR_CODES` are the STATUS CLASS on `error.code` (kernel's `DomainErrorCode` is derived
  from the first, so `DomainError` cannot carry a class the SPA has no wording for; the second
  adds `internal`, which `handleError` emits and no `DomainError` produces), and
  `CONFLICT_REASONS` is the finer `details.reason`. A `reason` union scoped to ONE surface lives
  with that surface instead (`tasks.ts`'s `TASK_SOURCE_READ_REASONS`), but the rule is the same:
  the code is declared HERE, so a rename fails the typecheck on both sides rather than degrading
  the SPA to the backend's untranslated prose.
- `execution.ts`: the pipeline STEP and run shapes. `run-provenance.ts` beside it holds the
  facts about a run rather than its work: `intakeOrigin` (how it entered: `ui`, `public-api`,
  `tracker` or `schedule`, classified by `isHeadlessIntake`, which the clarification writeback
  keys off), `mode` (whether it may land its work, read through `isDryRun`) and `diagnostics`
  (where it actually ran).
  All three ride the run's `detail` JSON, so a member is free to add and easy to forget to SET.
  Two rules follow: **`ui` is a positive claim that a human is watching in the app**, so every
  unattended start path names itself and only the in-app start may take the default
  (`intakeOrigin.coverage.spec.ts` in `@cat-factory/server` classifies each one); and
  **`isHeadlessIntake` is not "was anyone present"** but "is there a stable place to hold a
  conversation", which is why `schedule` answers `false`.
- `form-fields.ts`: ONE descriptor-driven form vocabulary (field shape, filled-value bag, and the
  pure visibility / validation / sanitization / prose-rendering rules) behind every surface where a
  DEPLOYMENT declares a form and the platform collects it: an initiative preset's create form
  (`initiative-preset.ts`) and a reusable operation's per-case brief on a custom task type
  (`task-types.ts`). Each surface declares only which input types it admits (a task type excludes
  `password` by construction). Lives here because the SPA's submit button and the server's create
  check must agree about every one of those rules, including DEFAULT seeding
  (`withDescriptorFieldDefaults`), which moved here from the SPA so a defaulted `required` field is
  not accepted from a form and refused from a script. A PARTIAL write goes through
  `validatePatchedDescriptorFields` instead, which splits the rules by author: per-VALUE checks
  apply to the keys the request named, because a stored value was admitted by another authority
  (a wider internal schema, an earlier descriptor revision) and re-judging it refuses a patch for
  something the patch did not do; `required` and visibility still read the merged RESULT.
- `public-task-types.ts`: what `GET /api/v1/task-types` serves and what `createPublicTaskSchema.fields`
  is validated against: ONE table for both directions, so what discovery advertises is exactly what
  creation accepts. `BUILTIN_PUBLIC_TASK_FIELDS` states the built-in types' fields as descriptors
  (they have no registration to read them off); it is a deliberate SUBSET of `taskTypeFieldsSchema`,
  and widening it is additive. `supersededBuiltinFieldKeys` states which of those keys are alternate
  SPELLINGS of one value (`review`'s `prNumber`/`prUrl`), so a MERGING patch drops the spelling the
  caller did not send rather than merging it back in to outrank the one it did.
- `agent-failure-kinds.ts`: the closed run FAILURE-KIND vocabulary plus `isAgentFailureKind`,
  the predicate for a string that may name a RETIRED member. A leaf module (valibot only) so
  every layer that must agree about the set can import it: the operator dashboard's breakdown,
  a platform-health alert rule naming a member as the subject of a page, and the env parser
  that asks whether an operator typed a real kind. The failure DIAGNOSTICS record built on
  these kinds stays in `execution.ts`, with the step shapes it composes.
- `repo-url.ts`: pure parsing of a pasted repository web URL (`parseRepoWebUrl` /
  `normalizeRepoSearchQuery`), shared by the SPA's paste-a-directory fragment import and the
  backend's available-repos picker (which resolves a pasted URL by its slug instead of feeding
  it to the provider's name search). Lives here because contracts is the only package both
  sides import.

- `run-evidence.ts` + `run-outcome.ts`: how a finished run's evidence is REDUCED, and the reason
  those rules are in a leaf package rather than in the engine. Two documents reduce one run: the PR
  verification report (`pr-report.ts`, composed in orchestration) and the run OUTCOME summary
  (`composeRunOutcome`, rendered by the SPA card and served at `GET /api/v1/runs/:runId/outcome`).
  `run-evidence.ts` holds every rule they BOTH state: `isTesterKind`, which tester step a section
  reports on, the verdict index across every tester step, the spec join, the regression rule, the
  tallies, the verdicts the join could not place, and `runSpecBranch` (the run's own branch, else
  the repo default). They lived on each side once and had already drifted on three axes (which
  testers count, what `not_covered` is counted over, and which BRANCH the spec is read from), so
  the same run printed different numbers depending on whether you read the pull request or the app. What each surface still owns is presentation and its
  own absence policy: the report writes prose onto a parsed host surface, the summary emits
  machine-readable `gap` codes the SPA maps to translated copy.

**See also:** `docs/glossary.md`, `CLAUDE.md` → "Board / service / repo-linkage model".
