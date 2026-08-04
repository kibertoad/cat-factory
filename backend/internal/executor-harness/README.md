# @cat-factory/executor-harness

The payload that runs **inside** a per-run Cloudflare Container (or a
[self-hosted runner](../../docs/runner-pool-integration.md)) to perform real
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
[`docs/runner-pool-integration.md`](../../docs/runner-pool-integration.md).

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
   (see [token-burn instrumentation](../../../docs/initiatives/token-burn-instrumentation.md)),
3. **prepopulate dependencies**, when the job body carries `dependencyInstall`: the
   service's install command is run with `sh -c` in the checkout BEFORE the agent starts, so
   it reads real installed packages instead of inferring a library's capabilities from a
   manifest entry. Best-effort and never a gate: the outcome (success or the captured
   failure) is folded into the agent's prompt (on EVERY pass, including the repair passes of
   steps 6 and 7, which start a fresh agent) and the run continues either way. Whatever the
   install materialises is excluded from git first, so no later `git add -A` can sweep a
   dependency tree into the pull request (see
   [dependency prepopulation](../../../docs/initiatives/agent-dependency-prepopulation.md)),
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
   as its instruction (see [pre-PR validation](../../../docs/initiatives/pre-pr-validation.md)),
7. **prove the reproduction**, when the job body carries `reproduction`: the declared check is
   run against the pre-fix tree and the tree the PR will open from, in two freshly-created
   symmetric `git worktree` checkouts, and only red-then-green is reported as proof (see
   [bugfix reproduction proof](../../docs/adr/0033-bugfix-reproduction-proof.md)). Unlike
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

### Skills and tool servers

A job body may carry `skills[]` (procedural playbooks) and `mcpServers[]` (MCP tool servers): the
harness MATERIALISES both and decides nothing about them; the backend has already resolved which
apply and dropped what this harness cannot serve (see
[`backend/docs/adr/0029-agent-kind-capabilities.md`](../../docs/adr/0029-agent-kind-capabilities.md)).

- **Skills** install natively under `CLAUDE_CONFIG_DIR/skills/<name>/` for a leased-credential
  claude-code run (the CLI discovers and invokes them), and under
  `.cat-context/skill/<name>/` in the checkout for Pi, Codex, and an AMBIENT claude-code run:
  whose prompt carries the instructions instead, because there is no isolated config home to
  install into and the runner refuses to write into the developer's own `~/.claude`.
- **Tool servers** become a per-run `--mcp-config` file plus `--strict-mcp-config` for claude-code
  (so an ambient run never picks up the developer's personal servers), and `[mcp_servers.*]` blocks
  in the per-run `CODEX_HOME/config.toml` for Codex: stdio only, and skipped entirely under
  ambient auth, which has no per-run home to write into. `--allowedTools` is passed ONLY when a
  server actually narrows its tools, and then carries the CLI's built-in tool names alongside the
  `mcp__*` patterns: an allow-list is whole-session, not MCP-scoped, so a bare list of MCP
  patterns would leave the agent unable to read, edit or build anything. Whether the CLI gates on
  that list at all is permission-mode dependent, so treat the narrowing as scoping rather than
  enforcement; the prompt states it either way.
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
| `src/runner.ts`    | `JobRegistry`: async job lifecycle, idempotent on `jobId`, progress tracking.                          |
| `src/job.ts`       | Request types + validators for the job specs.                                                           |
| `src/pi.ts`        | Pi provider config, non-interactive run, JSON-line event + todo-progress parsing, global `AGENTS.md` guidance. |
| `src/git.ts`       | clone / branch / commit / push + GitHub PR creation; bootstrap history reset + force-push.              |
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
| `src/bootstrap-mode.ts` | The repo-bootstrap MODE: clone-a-reference-or-scaffold → run the agent → refuse to push an empty tree → reinit + force-push to the pre-created target repo. |
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
[`.github/workflows/docker-publish.yml`](../../../.github/workflows/docker-publish.yml)
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
[`deploy/backend`](../../../deploy/backend)); a self-hosted runner pool pulls the
same image (see [`docs/runner-pool-integration.md`](../../docs/runner-pool-integration.md)).
The worker library's own test/dev `wrangler.toml` still references this
`Dockerfile` by local path so the acceptance suite can build it. Because the
version is the image tag, **bump this package via a changeset whenever you change
image content** (see [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)).
