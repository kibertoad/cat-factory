# @cat-factory/executor-harness

The payload that runs **inside** a per-run Cloudflare Container (or a
[self-hosted runner](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/runner-pool-integration.md)) to perform real
repo work with the [Pi coding agent](https://github.com/earendil-works/pi).

It is a thin TypeScript wrapper (a `node:http` server on `:8080`) that the
Worker drives over a small **job protocol**. Jobs run **asynchronously**: a `POST`
accepts the job and returns immediately with a `jobId`; the driver then polls
`GET /jobs/{id}` for live progress and the terminal result.

## Table of contents

- [Job protocol](#job-protocol)
- [What a job does](#what-a-job-does)
- [No secrets in the image](#no-secrets-in-the-image)
- [Layout](#layout)
- [Runner lifecycle knobs](#runner-lifecycle-knobs)
- [Build / test](#build--test)

## Job protocol

| Method & path     | Purpose                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /health`     | Liveness: `{ "status": "ok" }`.                                                                                       |
| `POST /run`       | Start (or re-attach to) an **implementation** job (`coder` / `mocker` / `playwright`). Returns `202 { jobId, state }`. |
| `POST /bootstrap` | Start a **repo-bootstrap** job (adapt a reference architecture → force-push a new repo).                               |
| `POST /blueprint` | Start a **blueprint** job (decompose a repo → write the in-repo `blueprints/` map, commit on a branch).                |
| `GET /jobs/{id}`  | Poll any job; returns the **job view** (`state`, optional `progress {completed,inProgress,total}`, `result`, `error`). |

All jobs run in a generic `JobRegistry` (`src/runner.ts`) keyed by `jobId`, so a
replayed `POST` **re-attaches** to the running job rather than starting a
duplicate (the durable driver's retries/replays are safe). Pi's todo-tool counts
are surfaced as `progress` while a job runs. The exact request/response shapes
cat-factory sends are documented in
[`docs/runner-pool-integration.md`](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/runner-pool-integration.md).

`GET /jobs/{id}` is also the harness's observability channel: `spans`, `followUps`
and `callMetrics` are **drain-on-read**; each poll returns what accumulated since
the previous one and clears the buffer. That is deliberate. A job that dies before
it can return a terminal result (an evicted container, an OOM-killed process) has
still reported the tool spans it ran and the model calls it paid for. Each drained
`callMetrics` entry carries a job-scoped `seq`, and the terminal result repeats the
complete list, so the backend can take both channels without double-counting a call.

Because the backend records a call as soon as it drains it (and ignores the terminal
repeat), a drained call is FINAL. A call whose tokens are still open (a CLI that reports
only a cumulative total, costed at the end) is withheld from the drain until it is
complete; see `createCallMetricPublisher` in `src/pi.ts`.

## What a job does

The implementation job (`POST /run`) is the canonical sequence:

1. **clone** the target repo (shallow) with a short-lived GitHub installation token,
2. write the composed system prompt (role + the block's best-practice fragments)
   to Pi's **global** context file `~/.pi/agent/AGENTS.md` (outside the checkout,
   so it never lands in a commit and never clobbers a repo's own `AGENTS.md`:
   Pi reads and concatenates both), and point Pi at the Worker's LLM proxy via
   `~/.pi/agent/models.json` (provider `proxy`, `api: openai-completions`): at the
   phase-tagged completions path for the pass about to run (`.../phase/<phase>`) when the job
   body's `proxyPhasePath` says the backend serves it, which is how a repair round's model spend
   stays distinguishable from the first pass's in telemetry; without that flag the plain path is
   used and the calls are recorded as unattributed
   (see [token-burn instrumentation](https://github.com/kibertoad/cat-factory/blob/main/docs/initiatives/token-burn-instrumentation.md)),
3. **prepopulate dependencies**, when the job body carries `dependencyInstall`: the
   service's install command is run with `sh -c` in the checkout BEFORE the agent starts, so
   it reads real installed packages instead of inferring a library's capabilities from a
   manifest entry. Best-effort and never a gate: the outcome (success or the captured
   failure) is folded into the agent's prompt (on EVERY pass, including the repair passes of
   steps 6 and 7, which start a fresh agent) and the run continues either way. Whatever the
   install materialises is excluded from git first, so no later `git add -A` can sweep a
   dependency tree into the pull request (see
   [dependency prepopulation](https://github.com/kibertoad/cat-factory/blob/main/docs/initiatives/agent-dependency-prepopulation.md)),
4. **resolve the repo's pull-request template**, when this dispatch opens a PR (`src/pr-template.ts`):
  `.github/PULL_REQUEST_TEMPLATE.md` and its root/`docs/`/multi-template-directory variants, or
   GitLab's `.gitlab/merge_request_templates/`, read straight off the checkout (a symlinked template
   is followed only while it resolves INSIDE the checkout: this is the one repo-chosen path the
   harness reads unprompted). Found, it is folded into the agent's prompt (on EVERY pass, as with
   the install above) asking it to write its briefing AS that template, filled in. This exists
   because neither host applies a template to an API-created pull request, so nothing else would:
   the template only reaches the web form a human opens. A directory of several templates with no
   `default` is left alone deliberately: it exists so a human can choose per pull request,
5. **run Pi** non-interactively (`pi -p --mode json --model proxy/<model> --approve`),
6. **validate** the checkout, when the job body carries `validationChecks`: the service's
   configured check commands (install/lint/test/build) run with `sh -c` in the checkout, and
   while they fail and the attempt budget remains the agent is re-run with the captured output
   as its instruction (see [pre-PR validation](https://github.com/kibertoad/cat-factory/blob/main/docs/initiatives/pre-pr-validation.md)),
7. **prove the reproduction**, when the job body carries `reproduction`: the declared check is
   run against the pre-fix tree and the tree the PR will open from, in two freshly-created
   symmetric `git worktree` checkouts, and only red-then-green is reported as proof (see
   [bugfix reproduction proof](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0033-bugfix-reproduction-proof.md)). Unlike
   step 6 this NEVER gates the PR: a failed verification is fed back to the agent while budget
   remains, then recorded as `inconclusive`. It runs BEFORE step 6 so validation stays the last
   thing to touch the tree,
8. **commit, push** a branch and **open a PR**, returning `{ prUrl, branch, summary }`, but
   ONLY if step 6 ended green. A spent budget returns an error result with the validation report
   and opens no PR. Absent `validationChecks` / `reproduction`, steps 6 and 7 do not happen at
   all. The PR's description prefers the agent-authored reviewer briefing over the generic
   dispatch-time text the job body carries: a PR-opening agent is prompted to write one to the
   `.cat-pr-description.md` sentinel at the checkout root (one per sibling repo in a multi-repo
   run; an optional leading `# <title>` line, when it is the file's only `#` heading, sets the PR
   title), and `src/pr-description.ts` lifts it; secret-scrubbed, size-capped with a visible
   note, made inert for the host by `src/host-markdown.ts`, kept out of the commit like the
   effort/follow-ups sentinels; onto `openPullRequest`. Absent or unusable ⇒ the fallback text,
   unchanged. When the repo ships a template (step 4) that briefing IS the filled template: it
   crosses the same scrub/cap/inert boundary on the way out, but the leading-`#` title rule is
   switched OFF for it (`titleFromHeading: false`), because those headings are the repo's and
   lifting the template's top heading would retitle the PR after it and drop it from the body. On a
   RESUMED run the PR already exists, so an agent briefing additionally refreshes its
   title/description in place (carrying the engine's managed report region across); the generic
   fallback never does, so a human's edit is safe.

Bootstrap differs at the ends: it may start from an empty dir, and **resets
history to one commit and force-pushes** the default branch instead of opening a
PR. Blueprint **commits onto a branch** (no history reset) and returns the tree.

### The work-branch push is CHECKPOINTED, so it is lease-guarded

Step 8's push is not the run's first: every `JOB_CHECKPOINT_INTERVAL_MS` (60s) the harness pushes
whatever the agent has committed and NOT yet published, so an evicted container's work survives on
the branch and a retry resumes on top of it. The interval is a **loss window**, not a push rate:
`unpublishedWorkBranchTip` skips a tick whose branch tip is already published, so a long run pushes
once per commit the agent makes rather than once a minute, and nothing here needs tuning per model.

That makes the harness its own competing writer. A commit is published within a minute of being
made, the agent cannot observe that from inside the container, and amending or resetting it
afterwards is ordinary git hygiene, so the final push used to be refused as a non-fast-forward and
failed the whole run with its work already on the branch.

Every push after the first therefore carries `--force-with-lease` against **the sha this pass
itself published**, never a tip it merely cloned. Two rules make that bound real, and both are
easy to get wrong:

- **The published sha comes from the push itself** (`pushBranch` names an explicit
  `<sha>:refs/heads/<branch>` source and returns it), not from `refs/remotes/origin/<branch>`. A
  fresh coding run clones a single branch, so `git push` creates no tracking ref for the work
  branch and a lease read back from one never arms at all.
- **The lease is withheld unless the branch still contains the tip this pass started from**
  (`workBranchLease`). Once a checkpoint has landed, a rewrite reaching below that tip would lease
  successfully against our own commit and carry an earlier run's work away with it.

The run's own rewrite lands; a SECOND writer's commits, and a rewrite this pass cannot claim, still
refuse the push. A refused push is not reported as a generic `git` fault but as the
`branch-contended` failure cause, which the engine recovers from by re-dispatching the step onto
the branch as it now stands (bounded by `MAX_BRANCH_CONTENTION_RECOVERIES`, counted as
`container.branch_contended` and recorded on the step for the debug API). The agents are told the
matching half of the rule: add commits, never rewrite them (`PLATFORM_DELIVERY_CONTRACT`).

### Reference designs

A job body for a kind that CAPTURES views (the UI tester, or a deployment's own browser-driven kind)
may carry `referenceScreenshots`: the reference images the platform holds for the task, as
`{ url, token, files: [{ artifactId, fileName, view }], omitted: [view] }`. The harness downloads
each into `.cat-context/reference-screenshots/` before the agent's first turn and lists them, by view
name, at the end of the agent's context.

Only identities travel in the body (a design frame is a full-page PNG), and the bytes come back
from the backend over the SAME container session token the run already holds for the LLM proxy, so
this needs no extra credential. The FILE NAMES are the backend's, never derived here: the name is
how the agent learns the view name, and the platform pairs its capture against that name later.

A job for a kind that BUILDS a screen carries the same wire shape under `designImages`, downloaded
into `.cat-context/design-renders/` instead. Same transfer, opposite instruction: those are the
design to build, not the views to capture, which is why they get their own directory (a tester
reading the builder's handful would take it for the complete list of views to capture). The prompt
naming them is composed by the BACKEND, since only it knows whether this harness/model pair can be
shown an image at all and which views the run was not sent, so the harness speaks up only to
CORRECT that list when a picture did not land.

`omitted` carries the views the backend's cap dropped. They are stated to the agent beside the
transfers that failed, since from where it stands both are a view to capture with nothing to compare
against. This parser keeps a higher backstop of its own against a body claiming more files than any
real set has, and an entry past it joins `omitted` rather than vanishing: a cap that shortened the
list and said nothing would be indistinguishable, on disk and in the prompt, from a design that has
no such screen.

The pass is IDEMPOTENT over the checkout, which matters because a coding flow re-enters its
workspace once per repair round: a non-empty file already on disk is counted and never re-fetched,
and only a view that MISSED is retried. The per-image ceiling is enforced against the declared
length and against the stream as it arrives, so an oversized body is refused rather than buffered.

### Uploading what a job PRODUCES

The return leg of the same seam. A job body for a kind the backend gave a browser image to carries
`artifactUpload: { url, token }`, which the harness surfaces to the agent as `ARTIFACT_UPLOAD_URL`
/ `ARTIFACT_UPLOAD_TOKEN` — the variables the capturing prompt already names. The token is the run's
EXISTING container session token, so this grants no reach the job did not already have, and it is
registered for redaction before it can reach a log.

Which kinds get it is the BACKEND's decision (it keys off the kind's declared `ui` image), so the
harness passes it through for every mode rather than testing the agent kind: a container-side kind
list would be the same decision made twice, in the half that cannot see the registry. An unusable
spec drops the WHOLE seam — a URL with no token is an endpoint nothing can call — and the prompt
branches on the variable being unset, which is what makes an absent capability visible as manual
mode rather than as an upload that 401s.

### Generating binaries with the CLI's own tool

Codex ships an `image_gen` tool that works only on ChatGPT subscription auth (an `OPENAI_API_KEY`
session is routed elsewhere and never offered it). A job body carrying `generateImages: true`
enables it in the per-run `CODEX_HOME/config.toml` and redirects what it writes.

The redirect is the point. Codex writes to `$CODEX_HOME/generated_images/` and tells the model no
path for it, and `$CODEX_HOME` is where the run's decrypted subscription credential lives — so
neither "ask the agent where it saved the file" nor "send the agent to look there" is available.
Instead `generated_images` is created as a symlink into `.cat-context/binary-output/generated/`
before the CLI starts, so the file is where the agent was told to look the moment the tool returns,
with no polling and no race, and `$CODEX_HOME` stays unread. A post-run sweep moves anything a
failed redirect left behind and NAMES it, because an image that arrived too late to be stored is a
different fact from a run that generated none.

Opt-in per job because the tool bills the leased ChatGPT plan at several times an ordinary turn.

Unavailable under `ambientAuth`: there is no per-run home to configure or redirect, and
reconfiguring the developer's own `~/.codex` is the HOME-global mutation this harness never makes.
Unavailable is not silent — the backend has already composed a brief naming the staging directory,
so `createCodexHome` reports the gap and one sentence is folded into the prompt saying the tool
could not be enabled and nothing will appear there. A refused redirect gets its own wording (the
tool IS on, its output is only unreachable until the post-run sweep), and the teardown report reads
the same outcome, so a rescued file is never reported as a late arrival when the redirect never
existed at all.

`generateImages` is also a `/health` capability, so a runner pool on an image that predates it is
refused rather than run blind: the brief names the staging directory whatever the image does with
the flag.

### Skills and tool servers

A job body may carry `skills[]` (procedural playbooks) and `mcpServers[]` (MCP tool servers): the
harness MATERIALISES both and decides nothing about them; the backend has already resolved which
apply and dropped what this harness cannot serve (see
[`backend/docs/adr/0029-agent-kind-capabilities.md`](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0029-agent-kind-capabilities.md)).

- **Skills** install natively under `CLAUDE_CONFIG_DIR/skills/<name>/` for a leased-credential
  claude-code run (the CLI discovers and invokes them), and under
  `.cat-context/skill/<name>/` in the checkout for Pi, Codex, and an AMBIENT claude-code run:
  whose prompt carries the instructions instead, because there is no isolated config home to
  install into and the runner refuses to write into the developer's own `~/.claude`.
- **Tool servers** become a per-run `--mcp-config` file plus `--strict-mcp-config` for claude-code
  (so an ambient run never picks up the developer's personal servers), and `[mcp_servers.*]` blocks
  in the per-run `CODEX_HOME/config.toml` for Codex: stdio only, and skipped entirely under
  ambient auth, which has no per-run home to write into. Both stdio-only skips are now BACKSTOPS
  rather than decisions: the backend knows which transports each harness reaches and drops an
  `http` server from a Codex dispatch with a stated reason, so the prompt names the gap instead of
  advertising a tool this side then silently omitted. `--allowedTools` is passed ONLY when a
  server actually narrows its tools, and then carries the CLI's built-in tool names alongside the
  `mcp__*` patterns: an allow-list is whole-session, not MCP-scoped, so a bare list of MCP
  patterns would leave the agent unable to read, edit or build anything. Whether the CLI gates on
  that list at all is permission-mode dependent, so treat the narrowing as scoping rather than
  enforcement; the prompt states it either way. An `allowedTools` entry that is not a single tool
  name is DROPPED at the boundary, the comma above all: the list is joined into one argument with
  commas, so `search_issues,get_issue` in one entry would become a pattern matching nothing.
- **An `mcp__*` call is exempt from the no-edit progress bound**, like a read or a subagent
  dispatch: reaching a wired tool server is what the prompt tells the agent to do, so counting it
  would abort an edits-expected run for following its own instructions. It is neutral rather than
  edit-satisfying, and bounded by its own consecutive-call cap
  (`JOB_MAX_CONSECUTIVE_MCP_CALLS`) for the same reason the web cap exists. Every exempt family
  ALSO shares one backstop (`JOB_MAX_CONSECUTIVE_NON_ACTION_CALLS`), because each per-family cap
  resets on any call outside its own family: a run alternating a web search with a tool-server
  lookup trips neither, and having made no action call it never reaches the no-edit bound either.
- **An `http` tool server must be `https`, or loopback.** Its headers carry a resolved credential,
  so the job boundary refuses a cleartext off-box URL (the backend refuses the same at
  registration). `secretKeys` names which `env`/`headers` entries are credentials, so exactly those
  values are registered for redaction: scrubbing the whole map would turn ordinary config strings
  into `***` in every later log line.

Both config files carry this job's resolved credentials, so they are written to a per-job directory
(mode `0600`) and never into the checkout or a HOME-global path: see the next section.

## Per-job state: never a process- or HOME-global

A job's staging state (the tester's secrets, private-registry auth, a repo-sourced Claude
Skill) must be scoped to that job, not written into `process.env` or the home directory.

In a container those two ARE per-job (one job per process, and `HOME` belongs to that
container) so a global was a safe place to stage. The **local native transport** breaks both
assumptions: one long-lived host process serves every concurrent `ambientAuth` job, on the
**developer's own home**. A global there is shared mutable state across siblings, and writing
(or clearing) a dotfile destroys a file the developer owns.

So per-job values ride explicit **child env** (`RunOptions.agentEnv` →
`SubscriptionRunOptions.extraEnv`, merged over the inherited env at spawn) and per-job files go
under a per-job directory:

| State                | Container                                    | Native (`ambientAuth`)                                                    |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| Tester secrets       | child env                                    | child env (same path: the old `process.env` set/restore is gone)         |
| Private-registry auth | `~/.npmrc`; cleared when a job has no entries | per-job `.npmrc` + `npm_config_userconfig`, seeded from the developer's; theirs is never written or removed |
| Repo-sourced Claude Skill | installed into the isolated `CLAUDE_CONFIG_DIR` | not installed: read from the checkout's `.cat-context/skill/`, like codex |
| Codex image output | redirected out of the per-run `CODEX_HOME` into the checkout | not redirected: no per-run home exists, so the capability is reported unavailable rather than pointed at the developer's own `~/.codex` |

Two consequences worth knowing:

- **The skill's PROMPT follows the same split.** A native install gets a short pointer; every
  checkout-reading case (Pi, codex, ambient claude-code) gets the instructions folded in plus a
  pointer to `.cat-context/skill/`. That decision is the backend's `renderSkillForHarness`, which
  keys off `ambientAuth` as well as the harness: rendering an ambient run as an install would
  point the agent at a skill that is nowhere on disk.
- **`npm_config_userconfig` reaches less than `~/.npmrc` did.** npm and pnpm honour it; yarn does
  not. And it only reaches processes that are handed the job env, so anything the HARNESS itself
  spawns (the frontend stand-up's install/build, a ralph validation command) is passed
  `RunOptions.agentEnv` explicitly rather than relying on inheritance.

When you add per-job state, put it in one of those two places. `~/.pi/*` and
`~/.config/rpiv-web-tools` remain HOME-global, which is fine only because the Pi harness never
runs natively (the native router sends `ambientAuth` jobs (Claude/Codex only) to the host
process and everything else to a container).

## No secrets in the image

The image (built from the `Dockerfile`, base `node:26-trixie-slim`) contains
only `git` + the Pi CLI + this compiled wrapper: **no API keys, no GitHub
credentials**. Per job, the Worker passes a short-lived GitHub token and a
signed, model-locked LLM-proxy **session token** in the request body. Pi reaches
models only through the Worker proxy, which injects the real provider key (qwen /
Kimi / DeepSeek) and meters spend. The provider key never enters the container.

## Layout

| File               | Responsibility                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `src/server.ts`    | HTTP entry point; routes `/health`, `/run`, `/bootstrap`, `/blueprint`, `/jobs/{id}`.                   |
| `src/runner.ts`    | `JobRegistry`: async job lifecycle, idempotent on `jobId`, progress tracking, and the three per-job watchdogs (max-duration, inactivity, tool-silence).                          |
| `src/jsonl-stream.ts` | The BOUNDS on a child CLI's streams, shared by both runners: `JsonlLineReader` frames its JSONL stdout while refusing to buffer a runaway record, `BoundedTail` keeps a capped tail of raw output for failure quoting. Both watchdog timers and the poll endpoints share one event loop with this parsing, so an unbounded buffer here is how a container stops answering polls with no watchdog having fired. |
| `src/job.ts`       | Request types + validators for the job specs.                                                           |
| `src/context-manifests.ts` | The two manifests of FILES the backend stages into the checkout: the linked-context documents and the reference design images. Their shapes plus the defensive parse of each, sharing the basename rule that keeps a body-supplied name from escaping the directory or clobbering a repo file. Both stay job body fields, so `job.ts` remains the import site. |
| `src/pi.ts`        | Pi provider config, non-interactive run, JSON-line event + todo-progress parsing, global `AGENTS.md` guidance. |
| `src/pi-reduction.ts` | Reducing a Pi event stream to what the run PRODUCED (summary, stats, diagnostics, terminal failure), FOLDED as records stream rather than over a retained array — memory is O(largest record), not O(records). The array-taking entry points offline tooling uses are defined in terms of the same reducer. |
| `src/tool-silence.ts` | The tool-silence watchdog (F13) and the `ToolProgressWindow` an agent stream opens, beats and closes. Separate from the phase marker on purpose: a window is only meaningful while something able to reset it is running. |
| `src/git.ts`       | clone / branch / commit / push (lease-guarded: [The work-branch push is CHECKPOINTED, so it is lease-guarded](#the-work-branch-push-is-checkpointed-so-it-is-lease-guarded)) + GitHub PR creation; bootstrap history reset + force-push. |
| `src/bootstrap.ts` | The `/bootstrap` handler (clone-or-empty → adapt → reinit + force-push).                                |
| `src/blueprint.ts` | The `/blueprint` handler (decompose → render `blueprints/` → commit on branch).                         |
| `src/embed.ts`     | Bundled assets/templates written into the workspace.                                                    |
| `src/package-registries.ts` | Private-registry (npm) auth: renders the job's allowlisted entries into an npmrc; the user `~/.npmrc` in a container, a per-job file pointed at by `npm_config_userconfig` for a native job. |
| `src/agent-runner.ts` | The subscription-harness runners (`runClaudeCode` / `runCodex`): talk direct to the vendor with a leased OAuth token, lift per-turn usage/telemetry off the CLI event stream. |
| `src/claude-call-aggregator.ts` | Folds Claude Code's per-CONTENT-BLOCK `stream-json` envelopes back into the model calls they belong to (by `message.id`), reconstructs each call's request transcript, and routes subagent turns off the parent's chain. **Exported as the `./claude-call-aggregator` subpath and driven by the BACKEND too** (`runtimes/local`, for an inline step running on the developer's host `claude`), so it stays the ONE implementation: the per-envelope over-count it fixes inflated a measured 1.47M tokens to 5.53M, and both drivers have to learn that only once. That second driver is why the transcript is retained only to `MAX_TRANSCRIPT_CHARS` (stating what it stopped retaining) and why assembling bodies at all is a `bodies` switch: in a container the reconstruction is one job's memory in a box sized for it, in the backend it is per concurrent inline step in the orchestrator process. Unlike the compile-only `./embed`, this subpath is a `dist` import, which is why the package emits declarations, and why a consumer's typecheck depends on Turbo's `^build` edge having built this package first (see `tsconfig.json`'s `comment:buildOrder`). |
| `src/transcript-retention.ts` | Lifts the CLI session transcripts (`projects/` / `sessions/`) out of the isolated, credential-bearing config home before it is deleted, and prunes them on a TTL (debugging artifact retention). |
| `src/captured-command.ts` | The one way the harness runs a declared shell command on its own behalf: `sh -c` with a per-command watchdog, abort handling, conventional exit codes (124/127/130) and a scrub-then-bound output capture. Shared by both pre-PR verification phases so a fix to one cannot miss the other. |
| `src/dependency-install.ts` | Dependency prepopulation: `prepopulateDependencies` is the ONE seam every checkout-having mode calls; it runs the service's install command before the agent's first turn, excludes what the install materialised from git so no `git add -A` can sweep a dependency tree into the PR, and builds the prompt note describing the outcome. Best-effort: every failure shape becomes a note, never a failed job. Generic: keyed off the job body, never the agent kind. |
| `src/validation-checks.ts` | Pre-PR validation: runs the job's check commands in the checkout (bounded, secret-scrubbed capture, per-command watchdog) and drives the retry-until-green loop that gates the PR. Generic: keyed off the job body, never the agent kind. |
| `src/reproduction-proof.ts` | Bugfix reproduction proof: runs the job's declared reproduction command against two symmetric fresh worktrees (the pre-fix tree and the final tree) and computes red-then-green from the exit codes, with a repair loop that never fails the run. Generic: keyed off the job body, never the agent kind. |
| `src/agent-capabilities.ts` | The agent CAPABILITIES a job body carries: the run's `skills` (a `SKILL.md` payload + resources) and its `mcpServers` (tool servers): with their defensive parsing and the per-CLI config writers (`--mcp-config` JSON for claude-code, `[mcp_servers.*]` TOML for Codex). Backend-authored data the harness only MATERIALISES: adding a skill or a tool server is a backend registration, never a harness change. |
| `src/context-images.ts` | The TRANSFER half of both image manifests: downloads a manifest's images into a subdirectory of `.cat-context/` on the run's own container session token, bounded per image and per pass, and reports what did not land. Best-effort, time-bounded and IDEMPOTENT over the checkout, so a repair round re-costs a stat rather than a transfer. Shared, because the transfer is identical for both; what differs is what the files MEAN, which is each caller's own module below. |
| `src/design-images.ts` | The task's DESIGN PICTURES: downloads the manifest a building job body carries into `.cat-context/design-renders/`, for an agent CLI that can read an image into its turn. Says NOTHING on success (the backend's prompt already names every file and its view) and speaks only to correct that list when a picture is not here, because an agent told to open a file that is absent goes looking for the design rather than for the transfer. |
| `src/reference-screenshots.ts` | The task's REFERENCE DESIGN images: downloads the manifest a capturing job body carries into `.cat-context/reference-screenshots/` (on the run's own container session token) and composes the prompt block naming each file's view. Best-effort, time-bounded and IDEMPOTENT over the checkout, so a repair round re-costs a stat rather than a transfer. A reference that is not on disk is NAMED to the agent, whether a transfer failed or the backend's cap dropped the view, because on disk an absent file and a screen the design does not have are the same thing. Backend-authored throughout, including the file names. |
| `src/bootstrap-mode.ts` | The repo-bootstrap MODE: clone-a-reference-or-scaffold → run the agent → refuse to push an empty tree → reinit + force-push to the pre-created target repo. |
| `src/artifact-upload.ts` | The OUTBOUND half of the artifact seam: parses the body's `artifactUpload` and projects it onto the agent's env as `ARTIFACT_UPLOAD_URL` / `ARTIFACT_UPLOAD_TOKEN`, registering the token for redaction first. Passes through what the body carries and decides nothing: which kinds get the seam is the backend's call. |
| `src/codex-images.ts` | Codex's own `image_gen` output, staged where the agent can reach it: creates `$CODEX_HOME/generated_images` as a symlink into `.cat-context/binary-output/generated/` before the CLI starts, sweeps anything a failed redirect left behind, and unlinks (never follows) the redirect at teardown — a failed unlink is REPORTED, because that unlink is what stops the recursive delete reaching the checkout. Exists because codex exposes no path for what it generated AND `$CODEX_HOME` holds the run's decrypted credential, so neither asking the agent nor sending it there is available. |
| `src/agent-shared.ts` | The few helpers every agent MODE shares (effort-report folding, the capability fields forwarded to `runAgentInWorkspace`). |
| `src/logger.ts`    | Structured logging.                                                                                     |

## Runner lifecycle knobs

Read from the environment inside the container (also honoured by a self-hosted
runner):

| Env var               | Default         | Effect                                                      |
| --------------------- | --------------- | ----------------------------------------------------------- |
| `PORT`                | `8080`          | HTTP port the harness listens on.                           |
| `JOB_MAX_DURATION_MS` | `3600000` (60m) | Hard ceiling on a job's wall-clock time; force-fails after. |
| `JOB_INACTIVITY_MS`   | `600000` (10m)  | Kills a hung agent that produces no output for this long.   |
| `JOB_TOOL_SILENCE_MS` | half `JOB_MAX_DURATION_MS` (30m at its default) | Kills an agent that keeps producing output but completes no tool call for this long: the "chatty hang" neither watchdog above can see, since streamed output resets the inactivity timer on every chunk while nothing gets done (stuck-run audit F13). Armed ONLY while an agent CLI that reports completed tool calls is running (each runner opens its own window and closes it on exit), so clone / dependency install / push / a validation loop's check commands sit outside it — they are activity-silent by nature and bounded by their own per-command timeouts — and each repair pass opens a fresh window. Derived from the job ceiling rather than fixed. It fires only when output arrived during the window that elapsed, which is what leaves a genuinely quiet run to `JOB_INACTIVITY_MS` and its clearer diagnostic. `0` disables it. |
| `JOB_MAX_CONSECUTIVE_MCP_CALLS` | `40` | Consecutive tool-server (`mcp__*`) calls with no other tool call between before the run counts as a lookup loop. The counter-bound the no-edit exemption above owes; a per-kind `tuning.guardLimits` entry can only RAISE it. |
| `JOB_MAX_CONSECUTIVE_NON_ACTION_CALLS` | `200` | Consecutive calls of ANY no-edit-exempt family (reads, searches, web, tool servers, subagent dispatches) with no action call between them. The backstop above the per-family caps, since each of those resets on a call outside its own family; sized as a backstop rather than a research judgement, and reset by any `bash`/edit. |
| `JOB_COLD_START_MS`   | `120000` (2m)   | First-output window (ADR 0026 D4). A job that has produced nothing this long records a cold-start diagnostic (a likely onboarding/auth wedge) WITHOUT being killed: logged, exposed on `GET /jobs/{id}`, and folded into the failure `detail` if the job goes on to fail. `0` disables it. |
| `DEPENDENCY_INSTALL_TIMEOUT_MS` | a third of `JOB_MAX_DURATION_MS` (20m at its default) | Watchdog for the pre-agent dependency install; a timeout is reported as a failed install (exit 124), never a failed job. Derived from the job ceiling rather than fixed, and an explicit value is clamped by the same share: the agent is what waits on this, so setup can never consume the run it is preparing for. |
| `DEPENDENCY_INSTALL_HEARTBEAT_MS` | `30000` (30s) | How often the dependency install feeds the job inactivity watchdog. A cold install is activity-silent and `JOB_INACTIVITY_MS` is tighter than its own watchdog, so without this a healthy install aborts the run as "likely hung". |
| `VALIDATION_COMMAND_TIMEOUT_MS` | `900000` (15m) | Per-command watchdog for a pre-PR validation check; a timeout counts as a failure (exit 124) so one hung command can't wedge the loop. |
| `REPRODUCTION_COMMAND_TIMEOUT_MS` | `900000` (15m) | Per-command watchdog for a reproduction-proof setup or check command; a timeout counts as a failure (exit 124). |
| `REPRODUCTION_HEARTBEAT_MS` | `30000` (30s) | How often the reproduction proof feeds the job inactivity watchdog while it runs commands the agent is not producing output for. |
| `REPRODUCTION_TOTAL_BUDGET_MS` | `2700000` (45m) | Wall-clock ceiling on the WHOLE proof phase (every attempt, both trees, setup included). Attempts multiply two full tree runs each and the heartbeat above deliberately stops the inactivity watchdog from firing, so this is what bounds the phase. Checked at phase boundaries; exceeding it settles `inconclusive`, never a run failure. |
| `HARNESS_TRANSCRIPT_TTL_MS` | `259200000` (3d) | How long lifted subscription-CLI session transcripts are kept before the retention sweep prunes them. |
| `HARNESS_TRANSCRIPT_ROOT`   | `<tmpdir>/cf-agent-transcripts` | Where retained session transcripts are moved to (one dir per run). Meaningful only on a reused (warm-pool) container; a per-run container is torn down with the job. The TTL sweep deletes only dirs it created (each carries a `.cf-retained` marker), so pointing this at a shared directory never touches unrelated content, though a dedicated dir is still recommended. An override on a different filesystem than the config home falls back to copy-then-remove. |

## Build / test

```sh
pnpm --filter @cat-factory/executor-harness build      # tsc → dist/
pnpm --filter @cat-factory/executor-harness test       # unit tests
docker build -f Dockerfile .                              # the container image
```

The build context is just this package, so its `tsconfig.json` is intentionally
self-contained.

## Published image (GHCR + Docker Hub)

This package is published to npm (its zero-dependency `dist/server.js` is the
entry `@cat-factory/local-server` spawns in local native mode). In addition, its
**Docker image** is published publicly, multi-arch (`linux/amd64` +
`linux/arm64`), to **both GHCR and Docker Hub** so anyone can pull it without
building from source:

```
ghcr.io/<owner>/cat-factory-executor:<version>
docker.io/<org>/cat-factory-executor:<version>
```

Each is tagged with the package `version`, the commit `sha-…`, and `latest`.

**CI** does this automatically:
[`.github/workflows/docker-publish.yml`](https://github.com/kibertoad/cat-factory/blob/main/.github/workflows/docker-publish.yml)
republishes on every push to `main` that touches image content (`src/**`,
`Dockerfile`, `tsconfig.json`, `package.json`). Docker Hub is gated on the
`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repo secrets; without them it publishes
to GHCR only.

**Manually** (on demand, or to publish from a fork under your own namespaces):

```sh
# Log in first (one per registry you target):
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
echo "$DOCKERHUB_TOKEN" | docker login -u <dockerhub-user> --password-stdin

pnpm --filter @cat-factory/executor-harness run image:publish
```

The script ([`scripts/publish-image.sh`](./scripts/publish-image.sh)) builds the
multi-arch image once and pushes it to the selected registries. Override defaults
via env vars (`REGISTRIES`, `GHCR_OWNER`, `DOCKERHUB_ORG`, `TAG`, `PUSH_LATEST`,
`PLATFORMS`, `EXTRA_CA`): see the header of the script. Example: GHCR only;
`REGISTRIES=ghcr pnpm --filter @cat-factory/executor-harness run image:publish`.

A backend deployment references the image from `wrangler.toml`
(`[[containers]] image = "ghcr.io/<owner>/cat-factory-executor:<version>"`: see
[`deploy/backend`](https://github.com/kibertoad/cat-factory/tree/main/deploy/backend)); a self-hosted runner pool pulls the
same image (see [`docs/runner-pool-integration.md`](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/runner-pool-integration.md)).
The worker library's own test/dev `wrangler.toml` still references this
`Dockerfile` by local path so the acceptance suite can build it. Because the
version is the image tag, **bump this package via a changeset whenever you change
image content** (see [`CONTRIBUTING.md`](https://github.com/kibertoad/cat-factory/blob/main/CONTRIBUTING.md)).
