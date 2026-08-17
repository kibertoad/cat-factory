# `@cat-factory/acceptance`: the live-deployment acceptance suite

Adopts two empty repositories an operator created, scaffolds a service into each, ships a
cross-service feature onto a real k3s ephemeral environment, investigates and fixes the defect that
feature leaves behind, and finally files an issue as an OUTSIDE reporter and asserts the platform
delivered it and CLOSED it, against a LIVE local deployment with nothing faked. Full notes:
[`README.md`](./README.md).

**Entry:** `src/runAcceptance.ts` via
`pnpm --filter @cat-factory/acceptance run acceptance`.
**No test framework**: five scenarios (`src/scenarios/`) in ONE process, in the order
`src/scenarios/index.ts` lists them, driven by the kit's `runScenarios`, asserting with
`node:assert/strict`, bailing at the first failure. What that replaced, and the four properties the
driver now owns (order, bail, the gate before every scenario, no timeout):
[ADR 0057](../../docs/adr/0057-acceptance-standalone-runner.md).
Type stripping is Node's own, so THIS package's scripts carry no `--experimental-strip-types` (three
sibling internal harnesses still do) and it declares `engines.node >= 24`, matching the repository
floor. Nothing checks that at runtime by design: Node 24+ is a supported-platform statement rather than
a condition the suite degrades around. Trap: the loader is NOT what enforces it. Type stripping is on by
default from 22.18 and 23.6, so every command loads and runs below the floor, and `node src/…` working
is no evidence of the version. Needs a running deployment, a k3s cluster
and real model credentials; `src/config.ts` refuses with the whole list of missing VARIABLES, and
`src/prerequisites.ts` then refuses with the whole list of unsatisfied DEPLOYMENT conditions, each
carrying the steps and commands that fix it.

**Built on [`@cat-factory/acceptance-kit`](../../packages/acceptance-kit)**, which is this suite with
the suite taken out: the scenario driver, the ledger and journal mechanics, the prerequisite
vocabulary and its refusals, the waits, the run driver and the evidence reductions. What stays here
is what the kit cannot know: the prerequisites, the scenarios, the briefs, the configuration, the
personal-subscription prompt, and `src/identity.ts`, the one declaration the kit's refusals render
against (the run command, the resume variable, the configuration file, the docs link). Trap: the kit
is a BUILT workspace package while this suite is type-stripped, so a checkout that has never run
`pnpm build` cannot start a pass; any tree that can serve a local deployment has already done it.

**Setup entry:** `pnpm --filter @cat-factory/acceptance run configure` (`src/configureCli.ts`) writes
that `.env`. Its rule is **resolve rather than ask**: the workspace from `GET /api/v1/me`, the owner
from the VCS connection, the preset from the library joined against the model catalog, the cluster
from the kubeconfig (through `@cat-factory/cli`'s own `readApiServerCommand`/`readTokenCommand`, so
the namespace and secret name are not restated here). What it asks is the two tokens nothing can mint (the API key, and the
REPORTER token scenario 04 files with, whose provider page it opens prefilled) plus the two
repository names, and it then ADOPTS each one (`POST /api/v1/repos/link`, idempotent), STATING each
attempt's outcome: an unreachable repository gets the creation page and the steps only a person can
carry out. It never overwrites a value without naming it, carries unmanaged lines over byte for byte,
and prints neither token.

**The operator creates the two repositories; the suite ADOPTS them.** `canCreateRepos` is false for
every PAT connection and the App path creates only under `/orgs/{org}/repos`, so bootstrapping was
the one prerequisite no configuration could satisfy. Scenario 01 backs a service with each `repoId` and
scaffolds both through `pl_build` from the briefs in `src/instructions.ts`, which is why a scaffold
resumes exactly as a feature run does. `target-repos` gates on the repositories being REACHABLE AND
adoptable, and says outright that emptiness is not what it checked: no `/api/v1` read publishes it.
Trap: CREATING a repository does not make `GET /api/v1/repos` list it. That read serves the workspace's
LINKED projection and nothing links a new repository for you (the added-repository webhook does not
project one; a resync refreshes what is already linked). The suite therefore ADOPTS what it needs
through `POST /api/v1/repos/link` (added for this in surface 1.44.0) rather than asking an operator to
open the app, which is what makes a hand-written `.env` a supported way in; `target-repos` gates on
REACHABILITY, point-reading `/repos/available?q=owner/name` for anything not linked yet.
`src/adopt.ts` owns the one copy of the reachability steps (`unreachableRepoSteps`), printed by the
gate and by `configure` too, and they ask only for what no API can do: create the repository, grant the
credential access.
Second trap: `serviceId: null` does NOT mean free. A service homed on another board has no id this
workspace-scoped surface can return, so it answers null WITH `linkedElsewhere: true` and
`POST /api/v1/services` refuses; `src/adopt.ts` owns that verdict and the gate shares it. An existing
link is compared against the LEDGER's service ids, never against "is this a resume", since a ledger
holding one of the two services cannot vouch for the other.

**A pass on the operator's OWN subscription needs a PERSONAL token and a prompt, never a stored
password.** An individual-usage model (Claude / Codex / GLM) is a per-user credential, so a SYSTEM
token cannot even see it: the catalog answers `available: false` with `userScoped: true` on the ROW,
which `configure` and the `model-preset` gate render as "not visible to this system token" rather
than as a missing provider. Read the ROW, never the response's `excludesUserScopedModels`: that flag
is about models omitted ENTIRELY (locally-run endpoints), so labelling from it calls every unwired
model invisible and sends an operator to re-mint a token that will change nothing. `src/presets.ts`
owns the three-way verdict both commands share. The kit's
`@cat-factory/acceptance-kit/console-credential` holds the password for the process and nothing else
writes it down, and the header rides EVERY request through the client's
`fetch` seam once held rather than being attached at the call that first needed it: answering a park
re-mints the run's activation server-side, so a pass needs it for hours after the start.

**Asked ONCE per pass, up front in `src/runAcceptance.ts`, which is also where the pass's run id is
settled.** In one process the ask could now be lazy and still be made once; it stays up front because a
person is at the terminal when a pass STARTS and by design not twenty minutes in, when the first
dispatch would discover the model needs a password. Headless is the whole point of the suite, and an
operator who starts one walks away, so a requirement that can be established while they are there is
established there. It asks THROUGH the holder (`unlock.obtain`), so nothing hands a password back as a
value: the suite has no such function any more, which is what makes "written nowhere" structural rather
than a rule to remember. **The holder has ONE filling method on purpose.** Collecting up front and
withholding until the first `428` narrows the exposure to a few reads against the one deployment the
pass is pinned to (which consults the header only on the gated run calls), and pays for it by making
"the pass has the credential" a rule each future call site remembers through `withPersonalUnlock`
instead of a property of the client seam, discovered wrong hours later at a terminal nobody is at. The wiring is thin; every judgement lives
in `src/personalPasswordAsk.ts`, where it is unit-tested, because every one of them is a degradation.
Traps: the verdict reads `personalSubscription` and never `available`, because a
selectable personal-subscription model is exactly the case that still answers `428`; a catalog it
cannot read asks later rather than not at all, because the preflight owns diagnosing an unreachable
deployment; and NOTHING here may throw, since it runs before the first prerequisite is evaluated and
before a journal line exists, so a refusal thrown from it is the operator's entire output. The one
exception is a person pressing Ctrl-C (`PersonalPasswordDeclined`), which stops the pass because it
is a decision rather than a limit of where the pass is running.

Traps in the prompt itself: writing the password beside `CAT_FACTORY_API_KEY` would collapse a
two-factor credential into one file; it reads the CONTROLLING TERMINAL rather than `process.stdin`,
which whatever runs the script is free to make a pipe (vitest's forked worker then, `pnpm run`
now); and that device is opened READ-WRITE on Windows
(`consoleDevice`), because `SetConsoleMode` writes to the console input buffer. Opened `r`, `CONIN$`
reads fine and refuses raw mode with `EPERM` on a machine with a console right there, which is why the
prompt never once appeared on Windows. A console-less process cannot open `CONIN$` at all, so the
no-terminal refusal belongs on the OPEN, and the raw-mode failure is its OWN refusal naming its own
cause (a pty emulating a console without its modes), never "no terminal": that wording sent an
operator in a JetBrains terminal to go find one, and its remedies are per PLATFORM, since a `/dev/tty`
that will not enter raw mode is an ordinary container. The verdict on that switch is the stream's
`isRaw`, never "did not throw": Node reports the failure by EMITTING `error`, so on the
`process.stdin` fallback anything else already listening turns it into a quiet return, and a
success read off that would take the password with echo ON. Releasing it is `releaseTerminal` and it
may not throw, since it runs both on a refusal and at the instant a typed password is accepted: the
descriptor a `ReadStream` was constructed with is closed by DESTROYING the stream, so a `closeSync`
beside it is an `EBADF` that replaces the refusal on one path and hangs the prompt on the other. Same
rule, same reason, at the end of the read: the promise SETTLES before the trailing newline is
written, or a dead console handle strands it and echo is never put back.

**Every task the suite files pins `ACCEPTANCE_MODEL_PRESET`**, through the one door
(`filePinnedTask`), so a pass runs on the model it says it ran on rather than on whatever the
workspace default happens to be. The risk policy is deliberately NOT pinned: `auto-merge-policy`
grades the workspace default, and a pin would make that gate a check on a policy no run uses.

**A pass is watchable and resumable, and both are load-bearing rather than conveniences.**
`pnpm --filter @cat-factory/acceptance run status [runId|latest]` reduces the ledger and the
journal into where a pass got to, opening no connection to the deployment.
`ACCEPTANCE_RUN_ID=<id|latest>` resumes, adopting or re-attaching to whatever the previous attempt
left rather than re-filing it. The README tables both.

**And it is RESETTABLE, which is the other branch of every refusal over leftover state.**
`pnpm run reset [runId|latest] [--all] [--purge-repos] [--yes]` (`src/reset.ts` + `src/resetCli.ts`) deletes the service
frames this configuration would adopt, their tasks and the run history under them, then the local
files of the passes naming them. It exists because "delete the service frame that holds this one" was
an app act until `DELETE /api/v1/services/{serviceId}`, so the one way out of `target-repos` an
operator running headless could not take was starting over. Traps, each a decision the code states:
it PREVIEWS by default and `--yes` is the whole opt-in; it targets what the CONFIGURATION points at
(the two repositories' frames, this prefix's titles) rather than a ledger, since the state with no
other way out is the state whose ledger is gone, and NAMING a pass adds whatever its ledger holds; it
KEEPS a pass's files whenever any frame that ledger names is still on the board (refused, or never
targeted) OR a repository could not be freed, because the ledger is the only map from a leftover
frame back to a run id and an unfreeable repository is held by a frame no read here can name at all;
and it STATES what the run in hand does not reclaim (cluster namespaces always, and without
`--purge-repos` the repositories' content and any reporter-filed issue), so a cleared board never
reads as a fresh one. The PREVIEW runs that same retention rule, so it never lists files the apply
will keep, and anything unfreeable is a non-zero exit even when nothing was refused.

**`--purge-repos` is the PROVIDER half of that paragraph, on `ACCEPTANCE_VCS_TOKEN`**
(`src/providerPurge.ts` over `src/issuePurge.ts` + `src/repoPurge.ts`): it closes the issues this
suite filed and empties the two repositories back to their README. Its whole design constraint is
that a mistake must be undoable, since a `.env` can name the wrong repository: the emptying is a
commit ON TOP of the tip, every ref is tagged before it is touched, and the recovery command is
printed with the sha in it. Two traps beyond that. Each backup is the precondition of the ONE write
it protects, so a branch whose tag did not land is left in place while the rest goes ahead, and a
tag the provider says already exists is READ rather than believed (422 is also every way a ref
cannot be created at all). And the state files are per-pass while the repositories are shared, so a
reset that KEEPS a pass leaves its issue alone and then says outright that the pass is no longer
resumable: the retention would otherwise read as a promise the purge does not keep. Details, and the
token permissions it needs beyond filing an issue, are in the README.

**`--all` is a THIRD target beside those two, not a wider reading of them**: every frame
`GET /api/v1/services` lists plus every pass in the state directory, for the frames the narrow
questions structurally cannot see (a different `ACCEPTANCE_NAME_PREFIX`, repositories the `.env` has
replaced, a frame raised by hand). None of those blocks a pass, so no refusal prints the flag. Two
things it changes rather than widens: the PLAN states the scope outright, because a board holding one
pass renders an identical frame list either way and the reading is the safety property; and every pass
file goes, including a refused attempt's, because a board with no frames maps nothing and a kept file
is a run id `latest` may still resolve to. It needs the BOARD half of
the config only (`resolveBoardConfig`): demanding a cluster to clean up after one refuses exactly the
operator whose cluster has moved on.

Two traps, both learned from the same broken pass. **The RUN ID is settled once by the entry point
and handed to `buildHarness`**, never resolved in a scenario: it is the KEY to the ledger the
scenarios pass facts through, and under vitest per module graph meant per FILE, so five specs opened
five ledgers a second apart and every fact spec 01 recorded was invisible to spec 02. One process
makes that absence unrepresentable, which is why the injection guard that used to refuse it is gone. **The
`latest` pointer is written on the first FACT**, not when a ledger opens: a fresh attempt refused by
a prerequisite creates nothing, and pointing `latest` at it overwrites the pointer to the half-built
pass whose leftovers caused the refusal, leaving it reachable only by an id nobody wrote down. Which
is also why the two checks that refuse over leftover state name the OWNING pass's run id
(`findPassesNaming`) instead of offering `latest`, and why they name the pass PER SERVICE: leftovers
routinely span two passes, and no single resume continues both.

**"What ran last" and "what is worth resuming" are different questions, and `status` asks the
first.** With no run id it reports the pass that wrote to the state directory most recently
(`findMostRecentPass`), not the pointer: the report someone wants is of the attempt they just
watched, which is by construction the one that recorded no fact and so never claimed the pointer.
Asked through the pointer it answered "no acceptance pass found" while that attempt's journal sat in
the directory it named. A pass that created nothing still closes its report by naming the pass that
did, so the resume line is never an invitation to start over. Trap: `status` reads the same `.env` the
pass does, so `ACCEPTANCE_RUN_ID` reaches it too, and **the ARGUMENT asks a question where the
environment only PINS a default** (`resolveStatusTarget`, unit-tested). A named id is that pass either
way; a `latest` on the command line refuses when the pointer names nothing, because that is the
question asked, while a `latest` LINE in the `.env` (which the README offers as the dialect-free way to
resume) falls through to the pass that ran last rather than refusing about a question nobody asked.
**And a pass is identified by its FILE NAME**: the `runId` inside a ledger is a copy of it, so a
disagreement means a copied or renamed file, and `WorldStore` refuses rather than guessing which half
is right.

**Every line every command prints goes to STDOUT, refusals included, and no command calls
`process.exit`.** Both halves of one rule: an afternoon-long pass is piped to a file (`| tee pass.log`),
`tee` captures one stream and `process.exit` does not drain it, so a refusal on stderr or a report cut
mid-write is missing from exactly the log somebody kept. The exit code carries the verdict; the stream
carries the answer. Trap: an exit code says whether a scenario RAN (1) or whether the pass refused to
start (2), never whether anything was created, which is read off the ledger. And a boundary picks its
describer off `OperatorRefusal` rather than off which boundary it is: a refusal this suite authored
prints whole, and anything else is named as a suite bug and keeps its frames, since a `TypeError`
rendered as a refusal is one contentless sentence with no file and no line.

**It is NOT in CI and must never become so.** `test:run` points at `vitest.config.ts`, which
collects `test/**/*.test.ts` only: this package's own unit tests. The scenarios are not tests to any
runner, so nothing collects them by accident; what WOULD put real model spend and a cluster
requirement into every CI lane is widening that include to `**/*.test.ts` and adding a test file
under `src/`.

**Where things live**

| File                         | What                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/runAcceptance.ts`       | The pass: what is settled before it starts, what an operator reads, the exit code.                            |
| `src/identity.ts`            | Who this suite is, as the kit's refusals render it, plus the three commands only it prints. Unit-tested.      |
| `src/scenarios/index.ts`     | The ORDER, as an array, pinned by a test against each id's own numeric prefix rather than a copy of the list. |
| `src/scenarios/preflight`    | Reports each prerequisite as its own step. Creates nothing, and is the one UNGATED scenario.                  |
| `src/scenarios/adoptAndSca…` | k3s engine + a service per adopted repo + each one's manifest source + two `pl_build` scaffolds.              |
| `src/scenarios/featureWith…` | `pl_build` across both services; environment / CI / merge evidence.                                           |
| `src/scenarios/investigate…` | `pl_bugfix`; the `clarity-review` gate answered over `/api/v1`; the repro proof.                              |
| `src/scenarios/issueIntake…` | An issue filed as the REPORTER, delivered from its `ticket` link, and closed by the writeback.                |
| `src/`                       | The harness, plus `configure` and `reset`. Per-file roles are tabled in the README.                           |
| `test/`                      | Unit tests for the pure logic (config, prerequisites, ledger shape, status, k3s templates, configure).        |

**The rules the scenarios are written to** (each expanded in the README, and each the reason a
particular file exists):

0. **Refuse before spending, with the fix attached.** `src/prerequisites.ts` runs before EVERY
   gated scenario, not just in scenario 00: a resumed pass starts where it stopped, so a gate only the
   first one runs is one the resume path skips. The DRIVER runs it, off the scenario's own `gated`
   flag, so a new scenario cannot spend an afternoon without answering the question, and it is
   re-evaluated per scenario rather than cached, because a budget can be spent mid-pass. An unreadable probe is its own verdict, never read as
   "unmet", and it NAMES its cause: the kit's `probeFailure.ts` is a discriminated verdict over three
   states. "Never answered" is classified through kernel's `describeConnectionFailure` (because
   `error.message` renders every transport failure this gate can hit as undici's contentless `fetch
failed`), with the SDK's own deadline corrected to `timeout` since its abort marker is NAMED
   `AbortError`. "Answered with a refusal" carries the SDK's typed status, `code` and request id
   (an ENVELOPE-LESS 404 means an unmatched route: a deployment older than the suite, or a base URL
   naming the SPA), and the two unauthenticated root reads answer here too, through
   `DeploymentAnswerError`, which is why a status must not be flattened into a message. "Answered by
   something that is not the deployment" is a 2xx whose body is not JSON at all, which is the SPA or
   a gateway and the one answered failure that reopens the ADDRESS.
   A prerequisite that reaches a DIFFERENT host describes its own failures where it calls
   (`issue-credential`, through the same kernel describer): the runner's one probe context names the
   deployment, and a value cannot be true for two hosts.
   Every negative verdict carries a `Remedy` (numbered steps, pasteable commands, a doc),
   built by the check from what it just READ, so the command holds the real workspace id or account
   rather than a hole. A fix with no CLI names the screen and offers the read that confirms it:
   never a plausible-looking invented command.
1. **Assert on evidence the platform COMPUTED, never on agent prose.** The kit's `evidence.ts` reduces
   the verification report; grepping a coder's reply tests the model's phrasing, not the product.
2. **Never auto-answer an unplanned decision, and never answer one in FLIGHT.**
   The kit's `decisions.ts` answers `follow-ups` and `clarity-review` and hard-fails on everything else,
   naming the kind. Which of those two may be acted on NOW is `isActionable`, read off the status
   the platform reports and shared with the poll wait: the list keeps showing a review the driver
   is mid-cycle on, and reading "listed" as "answer me" waives the gate one poll after answering
   it. A loop that settles whatever it finds drives a run past decisions a person was meant to make
   and still ends `done`.
3. **A wait that expires states its last observation.** The kit's `deadline.ts` is the pass's only
   clock, and the runner introduces no timeout of its own (the vitest one was disabled for the same
   reason). A THROWN poll obeys the same rule: the deployment this suite polls restarts by design
   (a supervisor repairs it, `node --watch` cycles it), and one such restart killed a 41-minute
   pass on a single `ECONNREFUSED` while the run it was watching carried on. The kit's `deploymentOutage.ts`
   makes an unanswered poll an observation for two minutes and journals the recovery; an ANSWER is
   never waited through, because a refusal is evidence, and it is rethrown untouched so the SDK's
   status and request id survive. Two corollaries bite: only the four transport causes shaped like
   a restart are waited through (a DNS or TLS failure is its own diagnosis, and delaying it two
   minutes to then blame a restart is worse than reporting it), and an outage is journalled but
   never becomes the last OBSERVATION, since "it did not answer" is not evidence about the run.
4. **Report every failing claim, not just the first.** A pass costs an afternoon.

**The defect scenario 03 hunts is planted in the SPECIFICATION, not the code.** The two briefs in
`src/instructions.ts` disagree about whether pagination offsets are 0- or 1-based; each service is
correct against its own brief and passes its own review, so the mismatch survives to production the
way a real integration bug does. A defect planted in the implementation would be caught by
`pl_build`'s `reviewer` step and scenario 03 would find nothing. **So scenario 02 asserts the delivery
machinery worked, never that the product is correct**. That claim is scenario 03's, and it is settled
by fixing the bug.

**Two values reach the agents through the BRIEFS as well as the engine**, and a brief that names a
literal instead is the whole failure. The ingress host template and the image template are both
holes the platform fills at provision time, so `k3s.ts` threads each into `instructions.ts` and a
prerequisite renders each before a pass spends anything (`src/manifestTemplates.ts`). The image half
is what a lost pass taught: the briefs make `{{image}}` mandatory, the platform substitutes it from
the CONNECTION's `imageTemplate`, and an unfilled hole renders as the empty string, so a suite that
configured no template deployed `image: ""` and the apiserver refused the Deployment three agents
and one pull request in. The gate also STATES what it did not check: nothing here can see whether
anything published that reference, or whether the cluster may pull it, and both present as an
environment that provisions and never becomes ready.

**Changing a brief means re-checking the symptom.** The briefs, the bug report and
`test/evidence.test.ts` describe one specific off-by-one (page 2 repeats item 10, last page short).
Edit the pagination rules and that trace changes, so the bug report has to change with them or the
investigator is handed a symptom the code does not produce.

**Scenario 04 files its issue OUTSIDE the platform, and that is the point.** The reporter holds
`ACCEPTANCE_VCS_TOKEN` and talks to the provider's REST API (`src/vcsIssues.ts`), because an issue the
platform's own credential created and closed proves only that the credential works. The client is
provider-KEYED and `gitlab` is null with its reason stated (no `/api/v1` read publishes which instance
a connection talks to), so a GitLab workspace is refused by `issue-credential` rather than filed
somewhere invented. Two traps: the FILING is recorded in the ledger the moment it returns, since no
`/api/v1` read can hand an issue back and a re-filed one leaves the first open forever; and a closed
issue ALONE is not evidence, because a provider closes one itself when a merged pull request's text
carries `Closes #12` and that path posts no comment, which is why `checkIssueWriteback` grades the
close together with two distinct comments naming the pull request.

**Every workspace-scoped call goes through the published SDK**, setup included: the repository list,
ADOPTING one, backing a service with one, the cluster connection, a service's `provisioning`, the
preset pin and the wiring reads are all `/api/v1` operations. So a surface change that would break an integrator
breaks this suite at compile time, which is most of why it is worth driving the SDK rather than raw
`fetch`.

The only exceptions are `GET /health` and `GET /auth/config` in the kit's `deploymentApi.ts`, and the
reason is not convenience: both must answer for a deployment whose config failed to validate, which
serves a fallback app that 503s every other route. **A new call does not belong there.** Anything
scoped to a workspace has a key available, so it is a public endpoint, and adding one means adding it
to `routes/public-provisioning.ts` plus `scripts/sdk/surface.mjs` (generation fails without the entry).

**See also:** [`backend/internal/e2e`](../e2e/README.md),
[`backend/internal/sdk-smoketest`](../sdk-smoketest/README.md),
[`backend/docs/public-api.md`](../../docs/public-api.md),
[`backend/docs/local-k3s-environments.md`](../../docs/local-k3s-environments.md).
