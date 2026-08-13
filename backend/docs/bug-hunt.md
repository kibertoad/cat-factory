# Bug hunt

The interactive dual of the recurring [`bug-triage` pipeline](./bug-triage-pipeline.md): a human
picks a connected tracker and the service the work belongs in, the platform reads the matching
board's **open, unassigned** bugs and rates each on impact against implementation complexity, and
the human confirms one candidate. That candidate is adopted onto the board as a `bug` task with the
issue linked for context, and the standard bug-fix pipeline (`pl_bugfix`: investigate → triage →
spec → architect → coder → review → merge tail) starts on it immediately.

Same reading, same ranking vocabulary and the same downstream pipeline as the recurring triage
schedule. The one difference is **who decides**: triage claims the oldest match unattended on a
cadence, while a hunt shows a rated shortlist and waits for a person. That is the whole reason it
exists: a backlog worker is right for churning through known bugs, and useless for the question
"we have an afternoon, what is actually worth fixing?".

## 1. Shape

Three steps, one per user action, all under `/workspaces/:ws/bug-hunt/:source`:

| Step  | Route             | Effect                                                         |
| ----- | ----------------- | -------------------------------------------------------------- |
| Board | `GET /boards`     | Lists the source's boards (Jira projects / Linear teams)       |
| Hunt  | `POST /hunts`     | Reads + rates the board's open unassigned bugs. **No writes.** |
| Adopt | `POST /adoptions` | Imports the issue, creates the bug task, starts the run        |

A source whose provider cannot enumerate boards is refused with a machine-readable
`details.reason: 'boards_unsupported'`, and the SPA turns **that reason specifically** into a
free-text board field. Keying the fallback on "any error" instead would present an unreachable
tracker or an expired token as "type the board in yourself", which just moves the same failure to
the next click; those are shown as the errors they are.

### A repo-backed source has no board to pick

GitHub Issues and GitLab Issues put every issue in ONE repository, and the only repository a hunt
may read is the one the run's own service frame is linked to. So such a source offers **no board
control at all**: `POST /hunts` carries the `containerId` the adopted bug will land in, and the
board is the `owner/name` slug of that container's service repository, resolved through the same
`resolveRepoTarget` ancestry walk an issue SEARCH scopes with (`server/src/modules/tasks/sourceRepoScope.ts`,
shared by both surfaces so they cannot disagree about which sources have a board to choose).

Neither half of that is cosmetic. A picker over the connection's repositories would let someone
scan, rate, and then ADOPT a bug from a repository nothing on this board is linked to: the adopted
task's run resolves its repo from the block ancestry and would open its PR somewhere else entirely,
which is the same wrong-repo failure `resolveRepoTarget` has no first-repo fallback to avoid. And a
board the caller names beside a repo-backed source is **refused** (`details.reason:
'board_from_service'`) rather than ignored, because ignoring it answers a request to scan one place
with a scan of another. Listing boards for such a source is refused with the same reason, ahead of
the provider capability check, so the answer does not depend on whether that provider happens to be
able to enumerate repositories.

`board_from_service` is deliberately NOT `boards_unsupported`: those two lead a user to opposite
places ("there is nothing to type, pick the service" versus "type the board in yourself"). The SPA
knows which surface to render before it asks anything, off `TaskSourceState.repoBacked` (derived
from the provider's declared `repoScope`, like `supportsIntake`), so the refusals are defence in
depth for a client that ignored it rather than the everyday path.

A service frame with no repository linked has no issues to hunt: that is
`details.reason: 'repo_not_linked'`, the same refusal the issue search raises, worded on the hunt
form beside the scope it invalidates rather than thrown as a toast.

`BugHuntController` (`@cat-factory/server`) is member-tier, deliberately NOT mounted alongside the
admin-gated `TaskSourceController`: a hunt neither reads nor edits a connection, and what it does
(create a task, start a run) is exactly what the member tier is for. Gating it on
`integrations.manage` would mean only admins could pick up a bug.

### The tracker picker is also how a tracker gets ADDED

"Which board holds the bugs?" is a common place to discover the tracker holding them isn't
connected to this workspace yet, so the hunt's tracker selector is the same two-tier menu
`<ContextIssuePicker>` renders (both off the shared `buildSourceChoices` /`reconcileSource` in
`frontend/app/app/utils/sourcePicker.ts`, which `<ContextDocumentPicker>` renders over DOCUMENT
sources too): the trackers the workspace offers, then the ones it
could add. An add entry routes to **that tracker's own connect screen** (`ui.openTaskConnect`),
never to the Integrations hub: the hub is a directory the user then has to search, and the
tracker they just named is the one thing we already know.

Two consequences the wording and the wiring have to honour. The connect modal opens **over** the
hunt rather than replacing it, so the board scope, issue type and labels typed so far survive the
detour; and the hunt reconciles the offered set as it changes underneath it, so the tracker the
user left to add becomes the selection the moment it turns up offered rather than leaving them on
the old one wondering whether the connect took. A tracker that is connected but toggled off for
the workspace is offered as "enable", not "connect"; the same modal serves both, and a user is
never told to connect something they already connected.

## 2. It persists nothing

There is **no hunt table, no migration and no runtime-symmetry surface of its own**. A hunt is a
live provider read plus a model call; the response IS the state, and the SPA store drops it on
close. A stale ranking of a board that has since moved on is worse than no ranking.

The only durable effects happen at adopt time, and they are all pre-existing: an imported issue
row, a board task, an execution. Runtime symmetry therefore comes for free: every part is either
a provider (runtime-neutral by construction) or a service built in the shared `createTasksModule`.
What conformance pins is the **wiring**, not a schema: a facade that forgets to thread the ranking
assessor through `createCore` fails `defineBugHuntConformance` rather than silently offering a
board scan that never rates anything.

## 3. Reading the board

`TaskSourceProvider` gains two optional capabilities beside `searchIssues`:

- **`listBoards`**: the picker's options, for a source that HAS a board to pick. A provider
  without it is not silently reduced to an empty list: the service raises, and the SPA turns that
  into a free-text board field, which is a usable answer where an empty picker is not. A
  repo-backed provider implements it on no account (see above), and the service refuses the call
  before reaching it.
- **`listBugCandidates`**: the same `IssueIntakeQuery` vocabulary the recurring intake uses (now
  carrying `unassignedOnly`), returning the richer `BugCandidate` rows the rating reasons over
  (body excerpt, labels, priority, age, comment count).

**One vendor call per scan is a hard requirement, not an optimisation.** Every vendor's list
endpoint already returns the full issue payload, so a per-candidate detail fetch would be forty
extra round trips against a rate-limited API for data we were throwing away. Jira asks for a wider
`fields=` selection; GitHub reads the fields its `/search/issues` response already carries (which
is why `GitHubIssueSearchHit` grew optional `body`/`labels`/`createdAt`/`commentCount`); Linear
projects them in its GraphQL query.

**Every predicate is pushed into the vendor query**, including the unassigned narrowing
(`assignee IS EMPTY` / `no:assignee` / `assignee: { null: true }`); never fetch-all-then-filter.
The exclusion of already-adopted issues is one batched `listByWorkspace` read indexed in memory,
the same shape `BugIntakeService` uses.

The scan is capped at `BUG_HUNT_SCAN_LIMIT` (40) because the whole set goes into one rating
prompt. A board with more matching bugs comes back `truncated: true` and the UI says so: a
silently shortened list reads exactly like an exhaustive one. The service asks the provider for
**one past the cap** and trims: comparing the returned count against the cap instead cannot tell
"exactly 40 bugs, all of them here" from "40 shown, more behind them", and would tell a user their
board holds more than they can see whenever it holds exactly 40.

**The board scope is required, and validated rather than just interpolated.** A repo-less hunt's
`board` arrives in a request body, and GitHub's `repo:` qualifier is the one value the search
grammar takes bare, so `buildGitHubIntakeQuery` shape-checks it as `owner/repo` (every other value
it emits is quoted). Without that, a board of `owner/repo is:closed` would silently contradict the
`is:open` / `no:assignee` qualifiers the whole surface rests on. Jira escapes its project key into
a quoted JQL literal and Linear passes the team id as a GraphQL variable, so neither has the same
hole. The check stays even though a GitHub hunt's board is now platform-derived: the recurring
`bug-intake` schedule reaches the same builder with an operator-typed one.

A query with NO repository at all is refused outright, for a blunter reason: `/search/issues`
carries no implicit scope, so a boardless query returns whatever the credential can reach. Under a
GitHub App installation token that happens to be the installation's own repos (which is why an
unscoped query looked harmless), but under a PAT it is every public repository on GitHub. The
recurring `bug-intake` schedule runs through the same builder and does not merely display its hit:
it imports the issue and starts a pipeline on it. So a schedule stored without a repo fails its
fire loudly instead of scanning the world.

## 4. Rating

`BugHuntAssessor` is a kernel port and the inline `BugHuntAssessorService` is its default
implementation: structurally the `JudgeService` twin (resolve model → `generateText` → return the
raw extracted JSON for the caller's parser), built in `createTasksModule` from the model
dependencies every facade already wires. So rating needs no per-facade wiring, and a test harness
swaps in a deterministic fake through the same seam.

One difference shapes the class: **a hunt has no block.** It runs before any task exists, which is
the point, so there is no block pin and no per-task model preset to honour; the scope is the
workspace and the model is its `bug-hunter` default falling back to the routing default.

Three rules govern what the model is allowed to contribute:

- **It rates; it does not rank.** `impact` and `complexity` are 1-5 judgements on anchored scales;
  the **score is computed by `bugHuntScore`**, never read off the reply. A model asked for both a
  ratio and its operands will sometimes return a ratio that contradicts them, at which point the
  list a human reads is sorted by something its own rationale does not explain.
- **Tracker facts and model judgement never mix.** A candidate row is built from the provider's
  response and the assessment is joined onto it by `externalId` (case-insensitively; the vendors
  disagree with themselves about issue-key case). A verdict naming an issue the board did not
  return is **dropped**, because a hallucinated bug is one a human would try to fix.
- **It judges from the report only.** It has no checkout, so the prompt forbids asserting where a
  bug lives or how the fix is written, and requires a low confidence over invented detail. It must
  also rate every candidate it was given: a model that silently shortlists leaves a human believing
  the omitted bugs were considered and rejected.

Bug bodies are written by anyone who can file a ticket, so they are `redactSecrets`-scrubbed before
they leave the deployment, and the prompt frames them as data with the real instruction restated
**after** them.

### Degradation is stated, never silent

`analysisStatus` is the field the UI acts on, and the failure modes are kept distinct because they
need different fixes from whoever reads them:

| Status        | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `ranked`      | The model rated the candidates.                                      |
| `unavailable` | No rating model is configured on this deployment.                    |
| `failed`      | A model is wired but the assessment failed; scan still returned.     |
| `over_budget` | The workspace is over its spend budget, so nothing was spent rating. |
| `empty`       | Nothing matched on the board.                                        |

### The rating answers to the spend budget

A hunt is the platform's first **billable model call that is not behind a run start**, so the
budget check `RunAdmission` performs before a run has no equivalent here unless it is made one:
without it a workspace that has exhausted its budget (and therefore can no longer start the very
run a hunt exists to start) could still spend on rating, repeatedly, from a member-tier endpoint
with no in-flight cap.

`BugHuntService` takes the safeguard as the narrow `isOverBudget(workspaceId)` predicate (so the
integrations layer takes no dependency on `@cat-factory/spend`), checks it **before** the call, and
reports `over_budget` rather than folding it into `failed`: an exhausted budget is not a broken
model, and "raise the budget" is not the fix for a revoked key. Unwired ⇒ no guard, exactly as an
unwired spend service means no guard on a run.

A failed rating never costs the user the scan (the board read is useful on its own), but it is
never presented as a ranking either. A candidate the rating skipped carries `analysis: null` and
sorts last, rendered as "not assessed": a missing assessment must never read as a zero score.

The assessor **logs** the cause before throwing, because the service deliberately swallows the
error; without that a revoked key would surface to an operator as nothing but a permanently
unranked hunt.

## 5. Adopting

`BugHuntService.adopt` imports the issue and materialises it through the existing
`TaskLinkService.createTaskFromIssue`, now taking an optional shape (`taskType` + `pipelineId`) so
a caller that already KNOWS what the work is can pre-classify it. A hunted issue is a bug by
construction and the human just confirmed the pipeline, so the task lands as `taskType: 'bug'`
pinned to `BUGFIX_PIPELINE_ID` rather than as a generic `feature` to be re-classified by hand.

The service stops there. Starting the run needs the execution engine and the initiator's
personal-credential gate, so the controller composes it: the same split `BugIntakeService` uses
(read-and-claim in integrations, the engine half outside it), and the same shape
`PublicApiController` already uses for create-task-then-start.

**A failed start deliberately leaves the task on the board.** Unlike the public API's anonymous
initiative anchor (which rolls back, because nobody would ever find it), this is a task the user
explicitly adopted, carrying the issue link and the imported body. Deleting it would throw that
work away and leave them to redo the pick; they can press Run instead.

## 6. Where things live

| Piece                        | Location                                                                  |
| ---------------------------- | ------------------------------------------------------------------------- |
| Wire contracts               | `contracts/src/bug-hunt.ts`, `contracts/src/routes/bug-hunt.ts`           |
| Provider capabilities        | `kernel/src/ports/task-source.ts`                                         |
| Rating port                  | `kernel/src/ports/bug-hunt.ts`                                            |
| Scoring / parsing / ordering | `kernel/src/domain/bug-hunt-logic.ts`                                     |
| Prompt                       | `agents/src/agents/prompts/bug-hunt.ts`                                   |
| Vendor queries + mappers     | `integrations/src/modules/tasks/{jira,github-issues,linear}.logic.ts`     |
| Read + rate + adopt          | `integrations/src/modules/tasks/BugHuntService.ts`                        |
| Board scope resolution       | `server/src/modules/tasks/sourceRepoScope.ts`                             |
| Inline rating model          | `orchestration/src/modules/bugHunt/BugHuntAssessorService.ts`             |
| HTTP                         | `server/src/modules/bugHunt/BugHuntController.ts`                         |
| SPA                          | `frontend/app/app/components/tasks/BugHuntModal.vue`, `stores/bugHunt.ts` |
| Shared tracker selection     | `frontend/app/app/utils/sourcePicker.ts`                                  |
| Cross-runtime assertions     | `internal/conformance/src/suites/bug-hunt.ts`                             |
