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
  facts about a run rather than its work: `intakeOrigin` (how it entered: `ui`, `public-api` or
  `tracker`, classified by `isHeadlessIntake`, which the clarification writeback keys off),
  `mode` (whether it may land its work) and `diagnostics` (where it actually ran). All three
  ride the run's `detail` JSON, so a new member is free to add and easy to forget to SET: a
  start path that leaves `intakeOrigin` unset is claiming a human is watching in the app.
- `repo-url.ts`: pure parsing of a pasted repository web URL (`parseRepoWebUrl` /
  `normalizeRepoSearchQuery`), shared by the SPA's paste-a-directory fragment import and the
  backend's available-repos picker (which resolves a pasted URL by its slug instead of feeding
  it to the provider's name search). Lives here because contracts is the only package both
  sides import.

**See also:** `docs/glossary.md`, `CLAUDE.md` → "Board / service / repo-linkage model".
