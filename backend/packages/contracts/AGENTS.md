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
- `events.ts`: the `WorkspaceEvent` union pushed to the SPA; `errors.ts`: the `reason`/`code`
  vocabulary the SPA maps to i18n keys. Both axes are declared here: `DOMAIN_ERROR_CODES` /
  `API_ERROR_CODES` are the STATUS CLASS on `error.code` (kernel's `DomainErrorCode` is derived
  from the first, so `DomainError` cannot carry a class the SPA has no wording for; the second
  adds `internal`, which `handleError` emits and no `DomainError` produces), and
  `CONFLICT_REASONS` is the finer `details.reason`. A `reason` union scoped to ONE surface lives
  with that surface instead (`tasks.ts`'s `TASK_SOURCE_READ_REASONS`), but the rule is the same:
  the code is declared HERE, so a rename fails the typecheck on both sides rather than degrading
  the SPA to the backend's untranslated prose.
- `form-fields.ts`: ONE descriptor-driven form vocabulary (field shape, filled-value bag, and the
  pure visibility / validation / sanitization / prose-rendering rules) behind every surface where a
  DEPLOYMENT declares a form and the platform collects it: an initiative preset's create form
  (`initiative-preset.ts`) and a reusable operation's per-case brief on a custom task type
  (`task-types.ts`). Each surface declares only which input types it admits (a task type excludes
  `password` by construction). Lives here because the SPA's submit button and the server's create
  check must agree about every one of those rules.
- `repo-url.ts`: pure parsing of a pasted repository web URL (`parseRepoWebUrl` /
  `normalizeRepoSearchQuery`), shared by the SPA's paste-a-directory fragment import and the
  backend's available-repos picker (which resolves a pasted URL by its slug instead of feeding
  it to the provider's name search). Lives here because contracts is the only package both
  sides import.

**See also:** `docs/glossary.md`, `CLAUDE.md` → "Board / service / repo-linkage model".
