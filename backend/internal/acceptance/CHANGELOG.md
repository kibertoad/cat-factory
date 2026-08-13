# @cat-factory/acceptance

## 0.4.3

### Patch Changes

- Updated dependencies [95408c2]
  - @cat-factory/contracts@0.307.0
  - @cat-factory/kernel@0.297.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.40.0

## 0.4.2

### Patch Changes

- Updated dependencies [792ecde]
  - @cat-factory/kernel@0.296.1
  - @cat-factory/cli@0.12.0

## 0.4.1

### Patch Changes

- Updated dependencies [fc56d82]
- Updated dependencies [fc9afb4]
  - @cat-factory/contracts@0.306.0
  - @cat-factory/kernel@0.296.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.40.0

## 0.4.0

### Minor Changes

- a565d05: Run the acceptance scenarios from a plain Node entry point instead of vitest.

  `pnpm run acceptance` is now `node src/runAcceptance.ts`: the five scenarios in one process, in the
  order `src/scenarios/index.ts` lists them, asserting with `node:assert/strict`, stopping at the first
  failure. The suite used vitest as a shell while switching off almost everything vitest does, and paid
  for the parts it could not switch off (a module graph per spec file, a reporter owning the console) in
  a `globalSetup` hook, an RPC channel and a custom sequencer, all of which are gone: the run id and the
  personal password are ordinary values, and the ask now fills the unlock holder rather than handing a
  password back.

  Nothing the scenarios assert changed. The pass prints its own report (each step as it starts, the
  failure in full, then a summary naming which scenario broke and that the ones after it did not run),
  records a `failure` line in the journal that `status` can read from another window, and exits 2 rather
  than 1 when it refused to start at all. `acceptance:watch` is gone with the vitest config, and the
  entry points target modern Node, so they no longer pass `--experimental-strip-types`.

  Design record: `backend/docs/adr/0057-acceptance-standalone-runner.md`.

### Patch Changes

- a565d05: Close the gaps review found in the standalone acceptance runner.

  `status` now reads the package `.env` the way every other command does, so the `watch:` and `report:`
  commands the pass prints resolve to the same state directory the pass wrote to; read off the shell
  alone it answered "No acceptance pass found" about a pass that was running right then. A base URL is
  scrubbed at the three sites that print one, including the preflight step name the journal persists on
  failure, since userinfo in a URL is legal and that file is meant to be shareable. The pass has an
  error boundary: a throw from a scenario factory or from the closing report is now named as a failure
  of the SUITE, with the run id, both file paths and the resume command, instead of an unhandled
  rejection that exits 1 with none of them.

  The preflight report's evaluation is handed to the gate that runs seconds behind it, so a fresh pass
  no longer evaluates all fourteen prerequisites twice; every later gate is unchanged and still fully
  re-evaluated. `recordsFacts` classifies each ledger slot rather than scanning the whole object, so a
  future non-record field on the ledger cannot silently make every pass claim it created something,
  and `thrownLocation` cuts the message off a stack by its content instead of scanning it for `at `,
  which was lifting indented lines of this suite's own multi-line refusals out as if they were frames.

  The scenario order has a test again (it lost one with `src/specOrder.ts`), pinned as a relation
  between each id's numeric prefix and its position so adding a scenario in the right place passes.
  Also: the package root is resolved in one place rather than four, the driver's gate and failure seams
  drop a scenario argument nothing could implement, and the up-front password ask uses the pass's own
  SDK client instead of building a second one.

## 0.3.0

### Minor Changes

- abb038e: Give `reset` a `--purge-repos` flag that reclaims the provider side: the issues a pass filed as the
  reporter, and the contents a scaffold run pushed.

  Both were previously stated as leftovers because an `admin` key structurally cannot reach either. The
  emptying is recoverable by construction: an ordinary commit on top of the current tip (so the previous
  tree stays in history and one `git revert` restores it), every ref tagged at the sha it held before it
  is touched, and the recovery command printed with the report.

  The flag asks more of `ACCEPTANCE_VCS_TOKEN` than filing an issue does: Contents and Workflows
  read+write on both repositories (classic GitHub: `repo` plus `workflow`), because a scaffolded
  repository holds an Actions workflow and the provider refuses a commit that removes one otherwise.

## 0.2.2

### Patch Changes

- 4adccbc: Pin the acceptance specs to file-name order.

  The five specs are one narrative passing facts through the on-disk ledger, but nothing enforced the
  order they ran in: `fileParallelism: false` prevents two running at once and vitest's default
  sequencer was still free to reorder them from its results cache. With `bail: 1`, the slowest spec of
  the previous pass ran first, failed on a ledger key nothing had written yet, and stopped the pass
  before the spec that writes it had started.

## 0.2.1

### Patch Changes

- edd4fd0: A fourth built-in model preset, **GPT-5.6 Sol** (`mdp_chatgpt`), is seeded for every workspace
  alongside Kimi K2.7, GLM-5.2 and Claude Opus 5, so `claude | chatgpt | kimi` is finally expressible
  as a pin rather than as a note in a config file.

  It needs no new catalog route to be usable. `gpt-5.6-sol` carries an `openrouter` route and a Codex
  `subscription` route, which is the same pair `claude-opus` already had, so `effectiveVariant` lands
  on whichever the workspace holds: an OpenRouter key alone makes the preset dispatchable to a SYSTEM
  API key (a Codex subscription is per-seat and individual-only, so a system token may not spend one),
  and a connected subscription wins where there is one. Deliberately NOT a seeded default on any
  deployment shape: Cloudflare and Node still seed Kimi K2.7, local mode still seeds Claude Opus 5.
  The seed id names a VENDOR rather than a generation (`mdp_chatgpt`, not `mdp_gpt56sol`) so a built-in
  can roll its `baseModelId` forward without becoming a preset nobody selected; argued in ADR 0056.

  **An OpenAI API key is not one of those routes, and the run-start refusal now says which are.**
  `openai` is a first-class poolable provider with its own onboarding copy, so "add an API key for the
  provider" read as a `platform.openai.com` secret key, which cannot make this preset dispatchable.
  `providers_unconfigured` now names each unusable model's DECLARED routes, computed from the catalog by
  the new kernel `declaredModelRouteLabels`: `gpt-5.6-sol (needs OpenRouter or ChatGPT (Codex))`. That
  fixes the misattribution for every subscription-or-gateway-only model rather than for this one, and
  `details.models` still carries the bare ids the SPA and the four SDK clients read.

  **Model presets gained the catalog NAME channel pipelines already had.** The snapshot ships
  `modelPresetCatalogNames` beside `modelPresetCatalogVersions`, built from one `seedModelPresets()`
  read. A brand-new built-in has no stored row to take a name off, which is exactly the state the
  startup advisory offers to fix: without the map the SPA humanises the id, so every board created
  before this release would have been offered "Chatgpt" instead of GPT-5.6 Sol. A new optional field on
  the wire, so an older SPA keeps working off the humanised fallback.

  **The built-in seed is now ONE batched write.** `ModelPresetRepository.upsertMany` (mirrored D1 batch
  and Drizzle transaction, allow-listed for mothership mode) replaces a serial `upsert` per built-in on
  a path that runs at a workspace's first board load, where every shipped built-in used to add a
  round-trip. The single-default invariant is read over the batch: a promoted member demotes every row
  outside it, and each member's own flag stands as written.

  `catalog.test.ts` gains the assertion nothing else could make: every built-in's base model AND every
  per-kind override names a model `MODEL_CATALOG` actually ships. A preset's `baseModelId` is a plain
  string matched at DISPATCH, so a built-in naming a renamed or dropped model typechecks, seeds, lists
  and is selectable, then fails on the first agent step of whichever run picked it. The expectation is
  derived from the catalog rather than hand-listed, so a rename breaks a test instead of a live run. The
  conformance seeding assertion is derived the same way, and now compares the persisted rows against
  the catalog member by member and in order instead of counting them.

  The `acceptance-suite-operator-setup` initiative tracker is retired into
  [ADR 0056](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0056-acceptance-suite-operator-setup.md),
  its committed scope now complete.

- Updated dependencies [edd4fd0]
  - @cat-factory/kernel@0.295.0
  - @cat-factory/contracts@0.305.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.40.0

## 0.2.0

### Minor Changes

- 36e0c9b: A headless caller can now DELETE a board service, and the acceptance suite has a command that clears a
  board back to "before any pass ran".

  The two halves are one change. The acceptance preflight refuses a fresh pass whose target repository
  already backs a service frame an earlier pass created, and it offers three ways out: resume the pass
  that owns it, point the suite at fresh repositories, or delete the frame. The third was not a command:
  deleting a service was an app act, and a public-API key authenticates on `/api/v1` only. So the one
  branch an operator running a HEADLESS pass could not act on headlessly was the one that starts over.

  **`DELETE /api/v1/services/{serviceId}`** (`admin`, OpenAPI `1.51.0`) closes that, additively. It runs
  the same sequence the app's own delete does, so a run still going under the frame is stopped and its
  container killed before anything is removed. Two answers a caller branches on rather than retries: a
  frame holding UNFINISHED tasks is refused with `422 service_has_unfinished_tasks` (deleting one would
  discard work in flight along with its history, so meaning it looks like deleting those tasks first),
  and an ARCHIVED frame is a `404`, which is the population rule every per-service endpoint here
  follows. Archiving stays app-only, deliberately: a surface that publishes neither the archive nor the
  restore has no business deleting through one.

  That refusal is decided BEFORE the run teardown, which is the ordering both delete controllers now
  share (`BoardService.assertRemovable`, handing back the board list the teardown and the remove both
  reuse, so the sequence still costs one read). The guard used to live only inside `removeBlock`, one
  step past a teardown that kills every container, cancels every durable driver and deletes every run
  row under the frame: a `422` therefore described a board it had already emptied of exactly the
  history the refusal exists to protect. It now leaves everything as it was, which is what the SPA's
  own delete has always claimed too.

  **`pnpm --filter @cat-factory/acceptance run reset [runId|latest] [--yes]`** is what uses it. It
  targets what the CONFIGURATION would adopt rather than what a ledger remembers, because the gate
  refuses over the board as it stands and the hardest case is leftover state whose owning ledger is gone
  (another machine, another operator, a state directory somebody cleared). Naming a pass widens the
  target to that pass's whole ledger.

  Three properties are worth knowing before running it. It PREVIEWS by default and changes nothing
  without `--yes`, naming every frame, task and file, and the preview is decided by the same retention
  rule the apply runs, so a pass is listed under "to remove" or under "KEPT" and never under the one it
  will not get. It keeps a pass's local files whenever any frame that ledger names is still on the
  board, since the ledger is the only thing that maps a leftover frame back to a run id, and removing it
  strands that frame with no pass for the next refusal to name; a repository it could not FREE keeps
  every ledger for the same reason one step out, because the frame still holding it is one no read here
  can name at all. And it STATES what no key can reclaim: the two repositories keep whatever a previous
  pass scaffolded (with its branches and pull requests), a reporter-filed issue stays open, and per-PR
  cluster namespaces are untouched, so a cleared board is not a fresh one.

  One diagnosis it deliberately declines to make: `GET /api/v1/repos` reports `linkedElsewhere: true`
  with `serviceId: null` for a service homed on another board of the account AND for a frame ARCHIVED on
  this one (the flag is computed against the frames a board visibly lists), and the two have opposite
  fixes. Every message that names it now names both, `target-repos`' own remedy included, rather than
  sending an operator to a board that does not exist.

  `--all` clears the whole board rather than one configuration's share of it. The two questions the
  default asks are narrow by design (they answer the two refusals a pass earns), so a board accumulates
  frames neither can see: a pass run under a different name prefix, one whose repositories the `.env` has
  since replaced, a frame raised by hand. None of them blocks the next pass, which is why no refusal
  prints the flag and why it is an operator's request rather than a remedy. It reuses the task reads and
  deletes the surface already published (`GET /api/v1/services/{serviceId}/tasks`, whose pages it walks,
  and `DELETE /api/v1/tasks/{taskId}`), so the endpoint added here is still the only new one. Two things
  it changes rather than widens: the preview STATES the scope, because a board holding a single pass
  renders an identical frame list either way, and every pass file in the state directory goes with the
  board, a refused attempt's included, since a board with no frames left maps nothing and a file kept
  back is a run id `latest` may still resolve to.

  The suite's configuration now resolves in two halves, and `reset` needs only the BOARD half (the
  deployment, the key, the two repositories, the state directory). Requiring a cluster and a reporter
  token to clear a board would refuse exactly the operator whose cluster has moved on, which is who is
  resetting.

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/contracts@0.304.0
  - @cat-factory/sdk@0.40.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/kernel@0.294.1

## 0.1.13

### Patch Changes

- Updated dependencies [569181d]
  - @cat-factory/contracts@0.303.0
  - @cat-factory/kernel@0.294.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.39.0

## 0.1.12

### Patch Changes

- 10737f4: Give an acceptance pass ONE run id and stop a refused attempt from hiding the pass worth resuming.

  The run id was resolved per module graph, which is per spec FILE: five specs opened five ledgers a
  second apart, so no fact spec 01 recorded reached spec 02. It is now settled once in `globalSetup`
  and injected, and a spec handed none refuses rather than minting its own. The `latest` pointer moves
  to the first FACT a pass records, so an attempt refused at preflight no longer overwrites the pointer
  to the half-built pass whose leftovers caused the refusal, and the two checks that refuse over
  leftover state name that pass's run id instead of offering `latest`.

- 10737f4: Let `status` reach a pass that recorded nothing, and give a pass one identity.

  Moving the `latest` pointer to a pass's first recorded FACT made the pass an operator most often
  asks about unreportable: an attempt a prerequisite refused writes a journal saying why and never
  opens a ledger, so `pnpm run status` with no run id followed a pointer that named an older pass, or
  none at all. It now reports the pass that WROTE last, and a pass that created nothing closes its
  report by naming the pass that did rather than offering to resume itself.

  A pass is also identified by its file name now: a ledger whose stored `runId` disagrees is a copied
  or renamed file, and both `WorldStore` and `status` refuse it instead of pointing `latest` at an id
  with no ledger. The leftover-state refusals name the owning pass per service, so leftovers spanning
  two passes say what resuming either one leaves behind, and the `status` command they offer names
  that pass instead of resolving to whichever ran last.

- Updated dependencies [1a0b593]
  - @cat-factory/contracts@0.302.0
  - @cat-factory/kernel@0.293.0
  - @cat-factory/sdk@0.39.0
  - @cat-factory/cli@0.12.0

## 0.1.11

### Patch Changes

- Updated dependencies [7d1477c]
  - @cat-factory/kernel@0.292.2
  - @cat-factory/cli@0.12.0

## 0.1.10

### Patch Changes

- Updated dependencies [c09ddbe]
  - @cat-factory/kernel@0.292.1
  - @cat-factory/cli@0.12.0

## 0.1.9

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/contracts@0.301.0
  - @cat-factory/kernel@0.292.0
  - @cat-factory/sdk@0.38.0
  - @cat-factory/cli@0.12.0

## 0.1.8

### Patch Changes

- 0363eed: Ask for the personal password on Windows at all, and refuse by the RIGHT cause when it cannot.

  A pass pinned to an individual-usage model stops at its first dispatch to ask for the operator's
  personal password. On Windows it never asked: it failed with `Error: setRawMode EPERM`, errno -4048,
  naming neither the password it wanted nor anything to do about it.

  The cause is the OPEN, not the console. Turning echo off is `SetConsoleMode`, which WRITES to the
  console input buffer, so the handle needs `GENERIC_WRITE`; `\\.\CONIN$` was opened `r`, which reads
  perfectly well and then refuses raw mode with `EPERM` on a machine with a console right there.
  `consoleDevice()` now opens it `r+` and the prompt appears. Verified inside a vitest forked worker,
  the environment that makes this prompt awkward in the first place: `r` throws `EPERM`, `r+` enters
  raw mode and writes to `CONOUT$`.

  That also corrects what this file believed. The `EPERM` was read as evidence that a console-less
  process opens `CONIN$` happily, so the missing-terminal refusal was moved onto the raw-mode switch.
  A console-less process cannot open `CONIN$` at all (`EBADF`, the same fact as POSIX's `ENXIO` for
  `/dev/tty`), so that refusal belongs on the OPEN, where it started, and moving it there produced a
  confident refusal with the wrong cause: an operator in a JetBrains terminal was told to "run the
  suite from an interactive shell", which is what they were doing.

  So there are two refusals now, because they need two different actions. No device to reach:
  `noTerminal()`, unchanged. A device that reaches a terminal which will not stop echoing:
  `noHiddenInput()`, naming that cause and the way out FOR THE PLATFORM it is thrown on, since the
  second refusal is just as reachable on POSIX (a `docker exec` with no `-t`, a detached `screen`) as
  it is from the MSYS/mintty window `winpty` fixes. Named for Windows alone it would have been the
  same defect one platform over: a confident refusal with the wrong cause. `cmd.exe` is deliberately
  not among the terminals offered, though it implements console modes: this suite prints its Windows
  commands in PowerShell's dialect, so sending an operator there fixes one prompt and breaks every
  command printed afterwards. Raw mode is still entered by `openTerminal` rather than by the read,
  because being readable without echo is what that function promises and opening the device does not
  establish it.

  **And the verdict on that switch is the stream's own `isRaw`, not "the call did not throw".**
  `setRawMode` reports a failure by EMITTING `error`, which reaches a caller as a throw only because an
  unhandled `error` is what Node turns into one. On the `process.stdin` fallback path, where something
  else in the process is usually already listening, the identical failure arrives as a quiet return
  with echo still on, and a try/catch reads it as success: the prompt then takes the operator's
  password into the scrollback, which is the one thing this file exists to prevent, failing silently
  rather than refusing.

  Releasing them is `releaseTerminal`, and it encodes the one rule that cleanup has to get right: the
  descriptor a `ReadStream` is CONSTRUCTED with belongs to the stream, so `input.destroy()` is that
  descriptor's close and a `closeSync(fd)` beside it throws `EBADF` out of the cleanup. That cost both
  paths through this prompt. On the refusal path it came out of the `catch` and replaced the message
  naming the password and both ways out; on the ordinary path it came out of the `data` handler at the
  instant a typed password was accepted, leaving the promise unsettled and hanging a prompt that had
  already succeeded. Echo is now restored by the same function, guarded on the stream's own `isRaw`, so
  a prompt that could not be WRITTEN no longer returns the operator to a shell that echoes nothing. The
  end of the read obeys the same rule for the same reason: the promise settles BEFORE the trailing
  newline is written, because that write runs inside the `data` handler and a failing one would
  otherwise escape through `emit` and strand the promise, which is the identical hang by another route.

  The README now states the invocation together with what makes it work under vitest at all, which is
  the part that reads like it cannot: a worker is forked with piped stdio, so the prompt goes to the
  console devices directly rather than through the stdio the reporter owns.

  **And it is asked ONCE per pass, before the first spec, rather than once per spec file.** Vitest
  isolates every test file in its own module graph and its own worker process, so the holder in
  `fixtures.ts` cannot outlive the file that built it: asked lazily, a pass that starts and answers runs
  across four specs is asked four times, and each of those prompts is written while the reporter is
  redrawing test lines over it, which is how an operator ends up unsure whether their password was even
  accepted. `acceptance/globalSetup.ts` asks in the MAIN process before any worker exists and before a
  test line is printed, and hands the value to each worker through vitest's `provide`/`inject`, which is
  the RPC channel rather than a file.

  It asks only when it can tell one will be needed: the pinned preset's base model reporting
  `personalSubscription`, which is `personalSubscription` alone and never `available`, since a selectable
  personal-subscription model is exactly the case whose dispatch still answers `428`. A provider-key
  workspace is asked nothing. A catalog it could not read says so and leaves the ask at the first
  dispatch, so an unreachable deployment loses nothing and the preflight keeps ownership of diagnosing
  it.

  **That hook can only ever DELAY the ask, never end the pass.** It runs before the first prerequisite
  is evaluated and before a journal line exists, so anything it throws is the operator's whole output:
  no "your key is bound to another workspace", no "the pinned preset's model is unwired", no ledger, no
  journal, and no chance to fix the thing that was actually wrong. So a terminal it cannot ask on is
  PRINTED and continued from, and the dispatch that needs a password is what stops the pass, with
  everything the preflight found already on screen. The one refusal that does end it there is a person
  pressing Ctrl-C, which is a decision rather than a limit and would otherwise start an afternoon-long
  run that spends real money. All of that lives in `src/personalPasswordAsk.ts` with the hook reduced
  to wiring, because a degradation nothing tests is a degradation that quietly becomes an abort.

  Two consequences worth knowing. The password now sits in the main process's memory as well as each
  worker's, which is the cost of asking once; no copy is written down, which is the property the design
  protects. And `test.env` is not applied in the main process, so the `.env` reader moved to
  `src/envFile.ts` and is now read by the vitest config and the hook alike rather than existing twice.

  **Every command this suite prints with a variable in it is now rendered for the shell that will
  receive it.** The same session found the second half of the same problem: `VAR=value command` and
  `export VAR=value` are POSIX syntax, and between them they were hard-coded into the banner every spec
  file opens with, both prerequisite remedies that offer a resume, the line the status report ends with,
  the per-person prefix remedy, and the three remedies whose whole fix is one value (a workspace id, a
  repository owner, an ingress template). The banner is the most printed of them: it is where an
  operator whose pass died in spec 03 recovers the run id, and it has no other source. PowerShell has no inline environment prefix and no `export` at all, so it reads each as the
  command NAME and answers `CommandNotFoundException`. On the Windows machine this suite is documented
  to run a local deployment on, every one of those pasted into a failure. A remedy that does not parse
  is worse than no remedy, because it is offered as the thing to run, which is the rule `shellQuoted`
  already existed for.

  `operatorText.ts` (which owns how a value becomes text an operator pastes) now decides every dialect
  in ONE table, and the renderers above it say what they need rather than which shell is in play:
  `resumeInvocation` for a value scoped to one command, `envAssignment` for one that is kept, and
  `perPersonPrefixInvocation` for the one whose value is a live username substitution. That last one is
  also the one place a shell still expands what came from the environment, so the literal half is
  escaped per dialect: `ACCEPTANCE_NAME_PREFIX` is read verbatim from an operator's `.env`, and
  unescaped, a prefix holding `$(…)` was not a broken command but a command that RAN something else on
  paste.

  **The dialect follows the SHELL, not the platform.** Git Bash and MSYS are ordinary places to drive
  this suite from on Windows, and there the PowerShell form is worse than the POSIX one it would
  replace: bash expands `$env:ACCEPTANCE_RUN_ID` to nothing, answers `=: command not found`, and never
  reaches the command, so a printed RESUME silently starts a second pass. `SHELL`/`MSYSTEM` decide;
  `PSModulePath` deliberately does not, since Windows sets it machine-wide and Git Bash inherits it.
  `cmd.exe` reads as PowerShell, and that is a stated LIMIT rather than a decision: nothing in the
  environment separates the two (`ComSpec` is in both, and cmd's own `PROMPT` is inherited by a
  PowerShell started from a cmd window), while guessing the other way would hand `&&` to Windows
  PowerShell 5.1, which cannot parse it at all. What follows from the limit is that nothing may send an
  operator to cmd.exe, which is why the echo refusal above no longer does.

  **The PowerShell resume clears the variable it set.** `$env:` is the process environment: no block,
  function or child scope narrows it, so the form this suite printed set `ACCEPTANCE_RUN_ID` for the
  rest of that window and every later `run acceptance` in it silently resumed the finished pass. That
  is the exact cost `resumeInvocation` refuses to print a `.env` line for, and the POSIX prefix it
  replaces does not have it, so one "resume" meant two different things by dialect. It now renders
  `try { … } finally { Remove-Item Env:… }`: `finally` rather than a trailing `;`, because an
  interrupted pass is when a resume is likeliest to be wanted next.

  Each renderer is asserted for both dialects with an injected flavour rather than against
  `process.platform`, so the PowerShell form is covered by the Linux CI lane that would otherwise never
  execute it. The call-site tests compare against the renderer instead of restating a spelling, so
  shell knowledge lives in one place.

  The README documents both forms plus the `.env` line, which is the one form needing no dialect, and
  states what each costs: a line in the file persists until it is removed, and a hand-typed `$env:`
  without the clear persists for the session, so either one silently resumes a pass you meant to leave
  behind.

  Still POSIX-only, named as the exception in the README rather than left to be discovered: the `curl`
  remedies interpolate `$CAT_FACTORY_API_KEY`, which PowerShell expands as one of its own variables and
  sends as an empty bearer token. That is a sweep over every read and write command in
  `prerequisites.ts` and wants its own change.

## 0.1.7

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/contracts@0.300.0
  - @cat-factory/kernel@0.291.0
  - @cat-factory/sdk@0.37.0
  - @cat-factory/cli@0.12.0

## 0.1.6

### Patch Changes

- 01086d8: `GET /api/v1/models` now says whether a model's subscription is actually CONNECTED for the person a
  key belongs to, and stops calling the commonest one unwired. Surface version 1.47.0, additive: two
  new response fields and no change to anything already published.

  **The bug.** `userScoped` was added so a caller could tell "your credential was never consulted" from
  "no provider is wired", and it was derived from the route IN FORCE. A model with more than one route
  resolves, when nothing is configured, to the most-preferred route it merely DECLARES, and
  `subscription` is last in that order, so `claude-opus`, the built-in Claude preset's own model, which
  also declares OpenRouter, answered `userScoped: false`. The flag shipped to remove that misreport
  never fired for the model every report of it has been about; the acceptance suite kept printing "no
  provider wired for it" at operators whose workspace runs Claude every day, and the fix it named (add
  a provider key) was for a deployment that was already correct.

  **Why a new field rather than a corrected one.** `userScoped` is published, and correcting it in
  place would have moved its meaning in two directions at once: true where a model merely declares a
  subscription route (right), and no longer true for a POOLED vendor whose subscription route is in
  force (also right, and also a change under any consumer branching on it). So `userScoped` keeps
  answering exactly what it always answered and is marked superseded, `personalSubscription` is served
  beside it, and dropping the old half is a later change. `personalSubscription` is true where a model
  declares a subscription route whose vendor is individual-usage only, read through kernel's own
  `individualVendorForModelId`, the same predicate the run path gates a personal credential on. The
  pooled exclusion matters: a Kimi or DeepSeek token belongs to the WORKSPACE, so every key can already
  see it, and reporting one as personal sent an operator to re-mint a token when the fix was a pooled
  token or a provider key.

  **The existence field.** `personalSubscription` alone still stops one step short of useful: told a
  row cannot be judged, an operator's next move is to re-mint the token bound and see what happens,
  which is exactly how the last person to hit this found the answer. Each row now carries
  `subscriptionConfigured`: whether a personal subscription for that vendor is stored for the person
  the key belongs to (`actsAsUserId` when bound, else its minter), and `null` when there was nobody to
  ask about. Existence is a row lookup, so the deployment answers it without the personal password that
  OPENS the credential.

  That is also the correction to 1.45.0's reasoning, which rejected reporting this on the grounds that
  "the server cannot know whether one exists without a user". An unbound key does have a user for
  DESCRIPTION purposes: its minter, who is exactly who the remedy names. Reading it changes nothing
  about admission: `available` is still resolved under `actsAsUserId` alone, so a system token reads
  `available: false` beside `subscriptionConfigured: true`, and both are true. `createdByUserId` rides
  `PublicApiKeyAuth` for that one reader and stays provenance; nothing authorizes off it. The
  disclosure this trades (an `admin`-scoped key learns one bit about its minter, who need not be its
  holder) is documented on the field and in `public-api.md`.

  **Three fixes underneath.** A LAPSED personal subscription reported as configured (`has` checked
  existence where `unlock` checks expiry), so the catalog offered a model whose run was then refused at
  its first dispatch, naming the model rather than the subscription. Both credential stores answered
  the vendor sweep one single-row question at a time; `PersonalSubscriptionService.liveVendors` and the
  new `ProviderSubscriptionService.liveVendors` each answer the whole vocabulary in one read, on a path
  both the catalog render and every run start take. The pooled half needed a new
  `ProviderSubscriptionTokenRepository.listByWorkspace`, mirrored across D1, Drizzle and the local
  sqlite credential store with a conformance assertion.

  The acceptance suite reads all of it: `configure`'s menu and the `model-preset` / `agent-model` gates
  now distinguish five states with five different fixes, with the account model-family policy ranked
  ahead of every credential state (it is the one cause no credential can undo) and the state that
  matters most saying the subscription is connected and naming the token as the only thing in the way.

- Updated dependencies [01086d8]
  - @cat-factory/contracts@0.299.1
  - @cat-factory/kernel@0.290.1
  - @cat-factory/sdk@0.36.1
  - @cat-factory/cli@0.12.0

## 0.1.5

### Patch Changes

- 1bcdacc: Name the cause when an acceptance prerequisite probe throws, instead of reporting `fetch failed` or
  a bare status.

  A probe fails in three fundamentally different ways and the gate rendered all of them as the same
  sentence, because the catch that turns a thrown probe into an `unknown` verdict read `error.message`.
  The verdict is now a discriminated one, so the reader cannot be conflated: nothing about a transport
  failure is representable on an answered one.

  It never got an answer: on Node a transport failure is a bare `TypeError: fetch failed` with the
  informative link (`connect ECONNREFUSED 127.0.0.1:8787`, a DNS miss, an untrusted certificate) one
  `.cause` down, so a deployment that was simply not started reported those two words under a remedy
  listing three causes it had not distinguished, two of them about a credential a refused connection
  never sent. The new `src/probeFailure.ts` classifies the chain through kernel's
  `describeConnectionFailure`, the platform's one producer of connection verdicts, and relays its
  per-cause remedy rather than paraphrasing it. One class the chain cannot reach is corrected: the SDK
  aborts its own deadline with a marker NAMED `AbortError` (that is how the transport tells its
  deadline from a caller's cancellation), so a hung or firewalled deployment classified as `aborted`
  and was told to run the test again instead of being pointed at dropped packets. Kernel gains
  `connectionFailureHint`, the same per-cause sentence for a cause the caller classified, so the fix is
  a relay and not a second copy.

  It got an answer and the answer was a refusal: the SDK throws a typed `CatFactoryApiError` carrying
  the status, the machine-readable `code` and the `X-Request-Id`, and reading it as `error.message`
  threw all three away. A prerequisite driving an operation the running deployment is too OLD to serve
  reported `the check threw: 404 unknown: HTTP 404`, whose fix nothing in the message pointed at. An
  envelope-less 404 is now read as an unmatched route (a deployment behind the suite, or a base URL
  naming the SPA, which answers the same shape), separately from a `not_found` that names a real
  resource, and the request id travels with every refusal. The two unauthenticated ROOT reads answer
  here too: `DeploymentApi` throws a typed `DeploymentAnswerError` carrying the status, where a plain
  `Error` fell through to the unclassified branch and reported "no HTTP status came back, so suspect the
  check itself" one line under a detail quoting the 404. Their remedy is its own, because neither route
  takes a credential: what a status narrows there is which LAYER answered.

  Something answered and it was not the deployment: a 2xx whose body is not the JSON the route
  documents is neither a refusal nor a transport fault, and it is the only answered failure that
  reopens the address. The SPA (which serves a `/health` of its own), a login portal and an intercepting
  gateway all land here, from either surface: the root reads, and the SDK's `CatFactoryDecodeError`.

  Three smaller corrections of the same kind. Every remedy states how to RESUME rather than claiming a
  re-run starts clean, since the gate runs in every spec's `beforeAll` and a resumed pass reaches it
  with services adopted. A step promising "the command below" or "the request id below" is emitted only
  when that line is. And the base URL is scrubbed and shell-quoted wherever a remedy prints it, because
  userinfo is legal in one and no URL policy rejects it.

  `issue-credential` is the one prerequisite whose calls leave the deployment, so it now describes its
  provider-facing failures where it makes them (through the same kernel describer, with the provider's
  own address named) and its body read no longer escapes the check; the runner's single probe context
  cannot be true for two hosts. `configure`, the journal and the deployment root reads share one
  `describeThrown` for the whole chain plus the one fallback for a chain that said nothing.

- Updated dependencies [1bcdacc]
  - @cat-factory/kernel@0.290.0
  - @cat-factory/cli@0.12.0

## 0.1.4

### Patch Changes

- 195b248: Tracker writeback is ON by default, and `/api/v1` can now read and change it:
  `GET /api/v1/tracker/writeback` reports what a task's linked tracker issue hears as its pull request
  progresses, and `PATCH /api/v1/tracker/writeback` changes one action without moving the others.
  Surface version 1.46.0, additive.

  **BEHAVIOUR CHANGE, and worth reading before upgrading.** All three writeback actions (comment when
  the pull request opens, comment and CLOSE the issue when it merges, post a headless run's parked
  review findings) now default to ON for a workspace that has never configured them. All three were
  off. Nothing published said what the defaults were, so this is not an `/api/v1` break, but it IS a
  change a deployment notices: a board that never opened the issue-tracker settings panel now closes a
  linked ticket when its task's pull request merges, and comments on it twice on the way. A deployment
  that wants the old behaviour turns it off with one call to the new PATCH (or in the app), and a single
  task can still opt out through its own per-task override.

  The reasoning for the flip is that these actions only ever touch an issue a task is LINKED to, and
  nothing links one by accident: a link arrives because somebody imported the issue, the recurring
  intake picked it up, or a headless caller filed a task with `ticket`. Every one of those is a request
  to work the issue where it was filed, so the half-closed loop was the common outcome and the wrong
  one: a merged pull request beside an issue still sitting open with nothing on it saying the work was
  done. The default now lives in ONE place (`DEFAULT_TRACKER_WRITEBACK` in `@cat-factory/contracts`),
  read by the settings service, the writeback service and the SPA's panel, which previously spelled it
  three times.

  The public pair closes the last gap in the ticket-driven loop. A caller could file a task FROM a
  ticket and the platform would write back to that issue, but WHETHER it did was workspace
  configuration reachable only from the app, so the deployment shape that most needs the loop closed
  (nobody in the SPA at all) could neither read the disposition nor change it, and could not tell "this
  deployment leaves tickets open" from "the writeback is broken". Three things about the shape: it
  publishes the WRITEBACK half of `tracker_settings` and not the filing selection, which is a separate
  decision the writeback does not key off; the write MERGES, so a caller acting on one action cannot
  move the other two; and `updatedAt` is null when nobody has ever chosen, which is how a caller knows
  it is reading defaults rather than somebody's decision.

  **Every writeback write now merges, the app's own included.** An omitted action used to revert to the
  deployment default on the internal wholesale PUT, which the default flip above turns from harmless
  into a silent re-enable: the recurring-pipeline dialog persists a FILING tracker and names no
  writeback action, so scheduling a tech-debt pipeline switched writeback back on for a workspace that
  had deliberately turned it off. Absence now means "not moving this action" on both doors, which is
  the only reading any caller wanted, and the merge itself moved down into the two repositories
  (`TrackerSettingsRepository.merge`, replacing `put`), so the SPA panel and a headless patch naming
  different actions both land instead of one silently losing to the other's stale snapshot.

  The acceptance suite gains a fifth spec built on all of it: an issue filed on the backend repository
  by an OUTSIDE reporter (its own provider credential, since an issue the platform created and closed
  proves only that the credential works), a task filed FROM that issue over `/api/v1`, delivery through
  `pl_build`, and then the pair of claims that the platform CLOSED the issue and commented on it at both
  edges of the pull request's life. The pair matters because a provider closes an issue by itself when a
  merged pull request's text carries `Closes #12`, and that path posts no comment: a closed issue alone
  cannot tell the writeback from the host noticing a word an agent wrote. Two new prerequisites refuse
  before any of it spends anything, and `run configure` opens the token page prefilled.

- Updated dependencies [195b248]
  - @cat-factory/contracts@0.299.0
  - @cat-factory/sdk@0.36.0
  - @cat-factory/cli@0.12.0

## 0.1.3

### Patch Changes

- bc2478d: A public-API key now has an IDENTITY as well as a scope: a SYSTEM token (the default, unchanged) or
  a PERSONAL token its minter bound to themselves, which can run their own individual-usage
  subscription headlessly. Surface version 1.45.0, additive. Plus two bug fixes that made the old
  behaviour unreadable rather than merely limited.

  **The reported problem.** A workspace whose Claude runs come from a stored personal subscription was
  told by `GET /api/v1/models` that `claude-opus` was `available: false`, which the acceptance suite
  rendered as "no provider wired for it". Both statements are false, and the remedy they imply (add a
  provider key) is for a deployment that was already correct. The model was wired — as a credential
  belonging to a person, which a key-authenticated read is not allowed to see.

  **Two things were genuinely broken, independent of the feature.**

  `resolveWorkspaceCapabilities` did not know about NATIVE ambient execution. A vendor served by the
  host's own `claude`/`codex` CLI login (`LOCAL_NATIVE_AGENTS`) has no credential in either store, and
  the resolver consulted only those two stores, so the catalog and the pipeline-start guard called the
  model unconfigured on the very machine that would have run it. The personal-credential gate, reading
  the same allow-list, had already decided such a vendor needs no unlock: two halves of one decision,
  disagreeing. They now share `isAmbientNativeVendor`, which is where the executor's half already was.

  `GET /api/v1/models` could not say why a personal subscription's model was unavailable. The existing
  `excludesUserScopedModels` flag reports what an answer OMITS, and a subscription model is not omitted
  — it is listed, unjudged, because no user's credential store was consulted. Each row now carries
  `userScoped`, so the distinction is stated where it applies. Widening the response flag instead was
  tried and rejected: with no user resolved the server cannot know whether a personal subscription
  exists, so the honest predicate is "this deployment has `ENCRYPTION_KEY`", which is true nearly
  everywhere. A flag that is always true stops answering its question, and it would have re-pointed a
  published field at a new predicate under the same name.

  **The feature.** `POST /workspaces/:ws/public-api-keys` takes `actsAsSelf`, and the key row carries
  `actsAsUserId`. A personal token's runs record that person as initiator, `GET /api/v1/models`
  resolves under them, and a start/retry/decision call may unlock their subscription by sending
  `X-Personal-Password` — the same header, the same 428, and the same per-run activation the app uses.
  A system token behaves exactly as every key did before, including the `409
individual_model_unsupported` refusal, which is now reserved for the case no password could fix.

  Three properties bound it, and each is a shape rather than a rule to remember. The wire field is a
  BOOLEAN and the server reads the id off the session, so minting a key onto a colleague's
  subscription is unrepresentable rather than merely forbidden; a mint with no signed-in user is
  refused instead of quietly producing an unbound key. Headless provisioning (`POST /api/v1/keys`)
  can never bind, because a provisioning key holds nobody's consent to inherit. And the password is
  stored NOWHERE — not on the row, not in a session — so the binding alone spends nothing and a
  leaked personal token reaches that user's PAT (as a leaked session would) but not their
  subscription.

  A bound key attributes EVERY run it starts, not only the ones needing an unlock. The alternative
  makes one key produce runs under two identities depending on which model a task happened to pin,
  with two credential scopes and two merge-policy roles, and nothing in the request to say which.

  **And a bound run is that person's run all the way through, policy included.** The two public start
  routes resolve the bound user's workspace ROLE and pin it, so a headless start is admitted under the
  same role-scoped merge narrowing and the same dry-run sandbox its holder gets in the app: a key
  cannot land what the person behind it could not. An initiator with no role is not a lenient run, it
  is a run with no policy — which is what the bug-hunt adopt route once shipped, and why
  `runAdmission.coverage.spec.ts` makes every start route CLASSIFY itself. A retry deliberately keeps
  the ORIGINAL run's pinned authority instead (`buildResumedInstance`), because a re-drive is the same
  work under the authority it was first granted, and dropping it would launder a dry run into a live
  one via restart-from-step-0.

  `POST /api/v1/jobs` runs the same personal-credential gate as the board start. Being inline-only
  settles what a public run may DO (no container, no push) and says nothing about whose credential it
  needs: the inline harness leases a personal subscription for every individual-usage vendor, so
  skipping the gate there traded an actionable refusal for a run that dies at its first dispatch.

  Deliberately not lifted: `POST /api/v1/notifications/:id/act`. Its ci-/test-failure arm retries
  through a shared effect that mints no activation, so admitting a bound key there would trade a
  refusal the caller can act on for a run that dies at its first dispatch. Lifting it means threading
  the gate through that effect for the SPA and this surface at once.

  **Answering a park no longer re-derives a credential that is already fresh.** Each re-mint runs
  210k PBKDF2 iterations per vendor, which a human clicking through a run pays once and a headless
  driver answering eight follow-ups would pay eight times in a row — seconds of blocked event loop on
  Node, a CPU-limit kill on workerd. The interaction path now skips the whole gate while the run holds
  an activation with over half its life left, and both facades share one helper, so the SPA gets the
  same. The decision surface's refusal is returned as DATA (a `428` in that surface's own envelope,
  carrying the vendor and reason) rather than thrown, which is the invariant every other gate there
  already keeps.

  **`X-Personal-Password` is declared on the operations that read it**, so it reaches
  `docs/openapi.json` and the four generated clients instead of being discoverable only by getting a 428. Each client also gained a post-construction setter for it, since that is when a caller learns
  it is needed.

  **The acceptance suite** now runs on the operator's own subscription. It prompts for the personal
  password at the terminal on the first call that needs one — never at `configure` time, and never at
  all for a workspace on a provider API key — and holds it in memory only: not the `.env`, not the
  ledger, not the journal, because a copy beside `CAT_FACTORY_API_KEY` would put both halves of a
  two-factor credential in one file. The header then rides every request, since answering a park
  re-mints the run's activation server-side. `configure` and the `model-preset` gate now say "not
  visible to this system token" and name the fix, instead of the wrong one they used to name — read
  off the ROW, so a model that genuinely has no provider still reads as unwired, and an invisible
  workspace default stays SELECTED rather than being quietly swapped for a model nobody chose.

  The prompt opens the CONTROLLING TERMINAL rather than reading `process.stdin`. The suite runs under
  vitest, whose workers are forked with piped stdio, so a prompt built on stdin could never have asked
  anything: the one path this exists for would have thrown "stdin is not a terminal" on every pass. It
  is also stricter than the check it replaces, since a controlling terminal cannot be fed from a pipe
  or a file at all. And the entered password is no longer trimmed: a space is printable ASCII, so a
  legal password with one at either end was being silently altered and then reported as wrong.

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/sdk@0.35.0
  - @cat-factory/cli@0.12.0

## 0.1.2

### Patch Changes

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/cli@0.12.0
  - @cat-factory/sdk@0.34.0

## 0.1.1

### Patch Changes

- 7893f35: `/api/v1` can ADOPT a repository that already exists: `GET /api/v1/repos/available` lists what a
  workspace's connection can reach, and `POST /api/v1/repos/link` adopts one by name. Surface version
  1.44.0, additive.

  The hole they close was invisible from the surface. `GET /api/v1/repos` serves the repositories a
  workspace has LINKED, which is a set someone assembles in the app: linking is explicit per workspace,
  the provider webhook for an added repository does not project one, and a resync refreshes what is
  already linked rather than rediscovering the installation. So a repository that exists and is
  perfectly reachable is absent from every public read until a human opens the picker, and
  `POST /api/v1/services` answers 404 for its `repoId`, which is byte-for-byte what a caller gets for a
  repository that does not exist. A deployment could CREATE a repository through this API (1.41.0's
  bootstrap) and could not adopt one it already had.

  The two reads are a population pair rather than a duplicate, with `linked` as the join, so an absent
  repository is now diagnosable: reachable-but-unadopted appears in `/repos/available` with
  `linked: false`, and one that does not exist appears in neither. The adopt takes `owner`/`name`
  because a caller setting a workspace up from configuration knows the name and cannot know a provider
  id for a repository no public read lists; it is idempotent, answers the same row shape `/repos`
  serves (projected from the same read, so the two cannot disagree about whether a repository is free),
  and refuses an unreachable one with `404 repo_not_reachable`, a reason that covers "does not exist"
  and "your credential is not granted it" together because a provider answers those identically.
  `GitHubSyncService.linkRepoBySlug` resolves through the same path the app's own picker uses, and
  matches the OWNER as well as the name: a slug search can surface a look-alike, and linking that one
  would file a caller's work in someone else's account while answering 200.

  The acceptance suite uses them, which is what makes a hand-written `.env` a supported way in rather
  than a setup only `configure` could finish. Spec 01 adopts a repository the workspace does not hold
  instead of refusing; `target-repos` gates on REACHABILITY, point-reading `/repos/available` for
  anything unlinked and reporting "reachable but not adopted yet" as a pass; and `configure` adopts each
  repository rather than printing instructions for doing it by hand. Every attempt states its outcome,
  because a loop that reports only its positive answer is indistinguishable from one doing nothing, and
  what a refusal now asks for is only what no API can do: create the repository, and grant the
  credential access to it.

  Review follow-ups on the pair, all still inside 1.44.0 and still additive:

  Both rows now report whether a repository is SPOKEN FOR, from one account-scoped judgement.
  `/repos/available` publishes `serviceId` and `linkedElsewhere` exactly as `/repos` does, because a
  repository nobody here has linked can still back a service on another board of the account, and
  `POST /api/v1/services` refuses it either way. A discovery read that could not say so handed a
  caller a repository whose next call fails, and it was the acceptance gate that felt it first: it
  green-lit a pass that then died on the adopt, after the run the gate exists to precede. The
  judgement is now `PublicBoardReads.repoUse`, asked once of the projection (the repos list) and once
  of a batch of ids (the available read), so there is no second derivation to drift.

  The available read also publishes `truncated`. The provider legs behind it stop at a page cap and a
  search cap, so on a wide connection the rows are a prefix and a reachable repository can be missing
  from them, which is indistinguishable from the non-existence this read exists to diagnose. A
  point-read (`?q=owner/name`) resolves the exact slug directly and stays authoritative either way.

  A provider refusal is answered as one on BOTH operations and on either provider. The available read
  was left unwrapped, so a revoked credential or a rate limit on it arrived as `500 internal` rather
  than the documented 503/429; and the mapping recognised `GitHubApiError` alone, so a GitLab-connected
  workspace got that same `500` for a revoked token on both routes. Kernel now owns a `VcsApiError`
  base that both provider clients extend, which is the identity a consumer above the adapters branches
  on.

  The adopt is idempotent for a repository the credential can no longer reach: it resolves from what
  the workspace LINKS before consulting the provider, so a re-run no longer answers 404 for a
  repository `GET /api/v1/repos` still lists (a personal repository, or a narrowed App grant). And the
  link's `owner` accepts a namespace PATH, so a GitLab project under nested groups can be adopted at
  all: the available read published `group/subgroup` and the adopt refused it with a 422.

  In the suite, "the connection cannot reach it" is now recognised by `details.reason`, not by the 404
  alone: a deployment older than these endpoints answers an unmatched route with the same status, and
  reading that as "create the repository" sent an operator to create one they already had.

  Internal, breaking for in-repo callers only: `GitHubSyncService.listAvailableRepos` answers
  `{ repos, truncated }` rather than an array, the kernel `GitHubClient.searchInstallationRepos` port
  answers a `Paged` rather than an array (every adapter caps something, and a search that filters a
  bounded listing can return two rows and still be a prefix, which no row count reveals), and the
  `viewerRepos` / `patInstallationRepos` caches hold the whole page rather than its items (an
  enumeration that stopped at the cap is a prefix, and caching only the rows served that prefix to
  every later keystroke as the complete set).

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/sdk@0.34.0
  - @cat-factory/cli@0.12.0

## 0.1.0

### Minor Changes

- c0412e9: The acceptance suite now ADOPTS two repositories the operator created instead of bootstrapping
  them, and ships a `configure` command that assembles its `.env`.

  Bootstrapping was the one prerequisite no configuration could satisfy: a PAT connection reports
  `canCreateRepos: false` for every workspace and the App creation path is org-scoped, so on the
  deployment shape the suite's own README offers first, spec 01 could not run at all. It now backs a
  board service with each named repository (`POST /api/v1/services` already takes a `repoId`) and
  scaffolds both through `pl_build` from the same briefs, which also makes an interrupted scaffold
  resume the way an interrupted feature run does. `vcs-connection` stops asking for repository
  creation, `target-repos` gates on both repositories being visible AND adoptable, and a new
  `model-preset` check joins the pinned preset against the model catalog so an undispatchable preset
  is named as one rather than found at the first dispatch. Every task the suite files pins
  `ACCEPTANCE_MODEL_PRESET`, so a pass runs on the model it says it ran on.

  Adoptable is the stricter half of that gate, and it reads `linkedElsewhere` rather than only
  `serviceId`: a whole-repo service homed on another board of the account has no id a
  workspace-scoped surface can return, so the repository row answers `serviceId: null` with the flag
  set, and `POST /api/v1/services` refuses it. An existing link on this board is compared against the
  LEDGER's own service ids, so a resumed pass holding one of the two services cannot silently adopt a
  colleague's other one. The two repository blockers, a monorepo and a foreign home, are refused
  identically by the gate and by the adopt itself.

  `pnpm --filter @cat-factory/acceptance run configure` resolves what the deployment and the
  kubeconfig already know (workspace, connected account, preset library, apiserver, ServiceAccount
  token), asks for the API token and the two repository names, and opens each repository's creation
  page prefilled. It never overwrites a value without naming it and prints neither token.

  `@cat-factory/cli` gains four exports (`readApiServerCommand`, `readTokenCommand`, `decodeToken`,
  `normalizeApiServerUrl`) so the new command asks a kubeconfig the same questions `cat-factory k3s`
  does, and normalises the answer the same way: k3d writes the undialable wildcard bind address
  `https://0.0.0.0:6443` into a kubeconfig, so the read and its rewrite travel together.

  Internal break, as pre-1.0 internals may: a ledger from an earlier pass is not read for its
  `bootstrapJobs`, so a pass interrupted mid-bootstrap under the old shape starts fresh rather than
  re-attaching to a job.

### Patch Changes

- Updated dependencies [c0412e9]
  - @cat-factory/cli@0.12.0

## 0.0.6

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/sdk@0.33.0

## 0.0.5

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/sdk@0.32.0

## 0.0.4

### Patch Changes

- f6a1a87: Read the acceptance suite's configuration from a `.env` beside its vitest config. The file was
  already gitignored and referenced, but nothing loaded it, so a fully configured `.env` still
  refused with every variable reported as missing. A variable exported in the shell wins over the
  file, so a one-off `ACCEPTANCE_RUN_ID=latest` still resumes.

## 0.0.3

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/sdk@0.32.0

## 0.0.2

### Patch Changes

- Updated dependencies [7119ca7]
  - @cat-factory/contracts@0.292.2
  - @cat-factory/sdk@0.31.0

## 0.0.1

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/contracts@0.292.1
  - @cat-factory/sdk@0.31.0
