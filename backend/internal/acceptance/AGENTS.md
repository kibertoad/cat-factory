# `@cat-factory/acceptance`: the live-deployment acceptance suite

Adopts two empty repositories an operator created, scaffolds a service into each, ships a
cross-service feature onto a real k3s ephemeral environment, investigates and fixes the defect that
feature leaves behind, and finally files an issue as an OUTSIDE reporter and asserts the platform
delivered it and CLOSED it, against a LIVE local deployment with nothing faked. Full notes:
[`README.md`](./README.md).

**Entry:** `acceptance/*.acceptance.ts` via
`pnpm --filter @cat-factory/acceptance run acceptance`. Needs a running deployment, a k3s cluster
and real model credentials; `src/config.ts` refuses with the whole list of missing VARIABLES, and
`src/prerequisites.ts` then refuses with the whole list of unsatisfied DEPLOYMENT conditions, each
carrying the steps and commands that fix it.

**Setup entry:** `pnpm --filter @cat-factory/acceptance run configure` (`src/configureCli.ts`) writes
that `.env`. Its rule is **resolve rather than ask**: the workspace from `GET /api/v1/me`, the owner
from the VCS connection, the preset from the library joined against the model catalog, the cluster
from the kubeconfig (through `@cat-factory/cli`'s own `readApiServerCommand`/`readTokenCommand`, so
the namespace and secret name are not restated here). What it asks is the two tokens nothing can mint (the API key, and the
REPORTER token spec 04 files with, whose provider page it opens prefilled) plus the two
repository names, and it then ADOPTS each one (`POST /api/v1/repos/link`, idempotent), STATING each
attempt's outcome: an unreachable repository gets the creation page and the steps only a person can
carry out. It never overwrites a value without naming it, carries unmanaged lines over byte for byte,
and prints neither token.

**The operator creates the two repositories; the suite ADOPTS them.** `canCreateRepos` is false for
every PAT connection and the App path creates only under `/orgs/{org}/repos`, so bootstrapping was
the one prerequisite no configuration could satisfy. Spec 01 backs a service with each `repoId` and
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
owns the three-way verdict both commands share. `src/personalUnlock.ts` holds the password for the
process and nothing else writes it down, which is why it is asked for LAZILY (on the first `428`, so
a provider-key workspace is never prompted) and why the header rides EVERY request through the
client's `fetch` seam rather than being attached at the call that first needed it: answering a park
re-mints the run's activation server-side, so a pass needs it for hours after the start. Traps:
writing it beside `CAT_FACTORY_API_KEY` would collapse a two-factor credential into one file, and the
prompt reads the CONTROLLING TERMINAL rather than `process.stdin`, which under vitest's forked
workers is a pipe and would have made the prompt unaskable in the one place it is needed. A device
that device is opened READ-WRITE on Windows (`consoleDevice`), because `SetConsoleMode` writes to the
console input buffer: opened `r`, `CONIN$` reads fine and refuses raw mode with `EPERM` on a machine
with a console right there, which is why the prompt never once appeared on Windows. A console-less
process cannot open `CONIN$` at all, so the no-terminal refusal belongs on the OPEN, and the
raw-mode failure is its OWN refusal naming its own cause (a pty emulating a console without its
modes), never "no terminal": that wording sent an operator in a JetBrains terminal to go find one.
Releasing it is `releaseTerminal` and it may not throw, since it runs both on a refusal and at the
instant a typed password is accepted: the descriptor a `ReadStream` was constructed with is closed by
DESTROYING the stream, so a `closeSync` beside it is an `EBADF` that replaces the refusal on one path
and hangs the prompt on the other.

**Every task the suite files pins `ACCEPTANCE_MODEL_PRESET`**, through the one door
(`filePinnedTask`), so a pass runs on the model it says it ran on rather than on whatever the
workspace default happens to be. The risk policy is deliberately NOT pinned: `auto-merge-policy`
grades the workspace default, and a pin would make that gate a check on a policy no run uses.

**A pass is watchable and resumable, and both are load-bearing rather than conveniences.**
`pnpm --filter @cat-factory/acceptance run status [runId|latest]` reduces the ledger and the
journal into where a pass got to, opening no connection to the deployment.
`ACCEPTANCE_RUN_ID=<id|latest>` resumes, adopting or re-attaching to whatever the previous attempt
left rather than re-filing it. The README tables both.

**It is NOT in CI and must never become so.** `test:run` points at `vitest.config.ts`, which
collects `test/**/*.test.ts` only: this package's own unit tests. The acceptance specs are behind
`vitest.acceptance.config.ts`, which nothing but the `acceptance` script names. Adding
`acceptance/` to the default include would put real model spend and a cluster requirement into
every CI lane.

**Where things live**

| File                           | What                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `acceptance/00-preflight`      | Reports each prerequisite as its own test. Creates nothing.                                                        |
| `acceptance/01-adopt-…`        | k3s engine + a service per adopted repo + each one's manifest source + two `pl_build` scaffolds.                   |
| `acceptance/02-feature-…`      | `pl_build` across both services; environment / CI / merge evidence.                                                |
| `acceptance/03-investigate-…`  | `pl_bugfix`; the `clarity-review` gate answered over `/api/v1`; the repro proof.                                   |
| `acceptance/04-issue-intake-…` | An issue filed as the REPORTER, delivered from its `ticket` link, and closed by the writeback.                     |
| `src/`                         | The harness, plus `configure`. Per-file roles are tabled in the README.                                            |
| `test/`                        | Unit tests for the pure logic (config, gate, probe failures, ledger, journal, status, evidence, waits, configure). |

**The rules the specs are written to** (each expanded in the README, and each the reason a
particular file exists):

0. **Refuse before spending, with the fix attached.** `src/prerequisites.ts` runs in EVERY spec's
   `beforeAll`, not just spec 00: a resumed pass starts where it stopped, so a gate only the first
   file mounts is one the resume path skips. An unreadable probe is its own verdict, never read as
   "unmet", and it NAMES its cause: `src/probeFailure.ts` is a discriminated verdict over three
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
1. **Assert on evidence the platform COMPUTED, never on agent prose.** `src/evidence.ts` reduces
   the verification report; grepping a coder's reply tests the model's phrasing, not the product.
2. **Never auto-answer an unplanned decision, and never answer one in FLIGHT.**
   `src/decisions.ts` answers `follow-ups` and `clarity-review` and hard-fails on everything else,
   naming the kind. Which of those two may be acted on NOW is `isActionable`, read off the status
   the platform reports and shared with the poll wait: the list keeps showing a review the driver
   is mid-cycle on, and reading "listed" as "answer me" waives the gate one poll after answering
   it. A loop that settles whatever it finds drives a run past decisions a person was meant to make
   and still ends `done`.
3. **A wait that expires states its last observation.** The vitest timeout is off so
   `src/deadline.ts` fires first.
4. **Report every failing claim, not just the first.** A pass costs an afternoon.

**The defect spec 03 hunts is planted in the SPECIFICATION, not the code.** The two briefs in
`src/instructions.ts` disagree about whether pagination offsets are 0- or 1-based; each service is
correct against its own brief and passes its own review, so the mismatch survives to production the
way a real integration bug does. A defect planted in the implementation would be caught by
`pl_build`'s `reviewer` step and spec 03 would find nothing. **So spec 02 asserts the delivery
machinery worked, never that the product is correct**. That claim is spec 03's, and it is settled
by fixing the bug.

**Changing a brief means re-checking the symptom.** The briefs, the bug report and
`test/evidence.test.ts` describe one specific off-by-one (page 2 repeats item 10, last page short).
Edit the pagination rules and that trace changes, so the bug report has to change with them or the
investigator is handed a symptom the code does not produce.

**Spec 04 files its issue OUTSIDE the platform, and that is the point.** The reporter holds
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

The only exceptions are `GET /health` and `GET /auth/config` in `src/deploymentApi.ts`, and the
reason is not convenience: both must answer for a deployment whose config failed to validate, which
serves a fallback app that 503s every other route. **A new call does not belong there.** Anything
scoped to a workspace has a key available, so it is a public endpoint, and adding one means adding it
to `routes/public-provisioning.ts` plus `scripts/sdk/surface.mjs` (generation fails without the entry).

**See also:** [`backend/internal/e2e`](../e2e/README.md),
[`backend/internal/sdk-smoketest`](../sdk-smoketest/README.md),
[`backend/docs/public-api.md`](../../docs/public-api.md),
[`backend/docs/local-k3s-environments.md`](../../docs/local-k3s-environments.md).
