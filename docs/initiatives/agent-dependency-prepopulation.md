# Agent dependency prepopulation

Install a service's dependencies into the checkout **before the agent's first turn**, so a
repo-aware agent reads real packages instead of inferring capabilities from a manifest.

## Context

A container agent opens a fresh `--depth 1` clone. It sees `package.json`, `pyproject.toml`,
`pom.xml`, and nothing those manifests point at. The agent can read that a library is depended
upon but not what it actually exposes, so it guesses at APIs, re-derives type shapes that are
sitting on disk one directory away, or declines work it could have done. Reviewers and architects
suffer this worst: their entire job is reading the tree, and the tree is half missing.

The platform already knew the install command and was running it at the wrong time. Pre-PR
validation (`pre-pr-validation.md`) stores an ordered check list per service frame, and the
autodetector (`kernel/domain/validation-detectors.ts`) derives the ecosystem-canonical install
from lockfile evidence: `pnpm install --frozen-lockfile`, `npm ci`, `uv sync --frozen`,
`bundle install`, `mix deps.get`, `dotnet restore`. But those checks run **after** the agent
settles, so the install that would have helped the agent most is executed once it no longer
matters. The reproduction-proof initiative hit the same wall from the other side and papered over
it narrowly with a hand-declared `setupCommand`
([`bugfix-reproduction-proof.md`](../../backend/docs/adr/0033-bugfix-reproduction-proof.md) §D4).

A second premise turned out to be wrong, and it shaped how people reasoned about this: **our
containers are not network-restricted.** The image installs from the
public registry at build time and nothing fences egress at runtime; `GITHUB_ALLOWED_HOSTS` pins
the GitHub API host, it is not an egress firewall. Agents could always have installed their own
dependencies. They were never told to, and nothing had prepared the ground.

## Decision

**A per-service-frame `dependencyInstall` command, run by the HARNESS in the checkout before the
agent's first turn, on every dispatch that gets a checkout.** Its outcome is stated to the agent
either way.

### Why not leave it to the agent

Instructing the agent to install was the obvious cheap answer, and it is wrong on three counts.
It is deterministic work, and the harness principle is that the container **materialises, never
decides**: an agent left to guess picks `npm install` in a pnpm repo, rewrites the lockfile, and
that diff lands in the PR. It spends turns and context on a multi-minute install whose output we
already know how to capture and bound. And it is not reliably repeatable: the same task on the
same repo installs differently depending on what the model inferred that day.

### Why not prepopulate from the backend

The backend has no checkout. `RepoFiles` is a checkout-free HTTP facade by design, so shipping a
resolved dependency tree would mean reimplementing lockfile resolution per ecosystem in
TypeScript. The package manager already does that correctly, inside the container, where the
tree is going to live.

### Why it shares the validation-config row

`resolveValidationChecks` already runs a frame-chain walk on **every** dispatch and returns
`{ checks, maxAttempts }`. Hanging `dependencyInstall` on that same resolved object means
prepopulation costs a dispatch **zero** extra round trips. A separate table or a separate
resolver would have bought a second read per dispatch for a string that comes from the same row.

The two remain independent concerns, and the code says so:

- A service may declare **only** an install (prepopulate, verify nothing), only checks, both, or
  neither. `ValidationConfigService.set` deletes the row only when both are empty; keying the
  delete on `checks` alone would silently discard the install for exactly the repo shape this
  feature exists for.
- They are threaded onto the job body under **different rules**. `validationChecks` rides only a
  PR-opening, single-repo coding dispatch; that is what "pre-PR" means. `dependencyInstall`
  rides the **base** body: every dispatch with a checkout, explore kinds and in-place fixers
  included. Folding it in beside the checks would typecheck, pass every harness test, and leave
  every read-only agent exactly as blind as before.

### Why it is never a gate

A validation check is a **verdict** about the work; an install is **setup**. A private registry
the deployment has no token for, a toolchain the image lacks, a slow registry: none of those are
the agent's fault or the run's. So the phase is best-effort by construction: every failure shape
(`runCapturedCommand` maps a timeout to 124, a spawn error to 127, an abort to 130) becomes a
prompt note, never a failed job.

The note is stated in **both** directions, which is the part that is easy to skip and shouldn't
be. On success the agent is told the tree is ready and not to reinstall; otherwise it spends its
budget re-running an install that already ran. On failure it is told what failed and that it may
install what it needs itself: an agent that merely finds no `node_modules` and no explanation
concludes the environment is offline and works around a gap that isn't there.

### Detection had to be un-filtered

`ecosystem()` used to return `null` for a detection that produced only an install, because an
install alone verifies nothing and must not become a suggested check. That rule is still right
for checks and still applied, but it threw the install away before anything could read it, and a
`package.json` with dependencies and no scripts is precisely the repo prepopulation is for.

The rule moved from `ecosystem()` (where it discarded the detection) into
`detectValidationChecks` (where it filters each OUTPUT). One place now decides what a
verification-less ecosystem means for checks and for the install separately. Three consequences
had to be preserved deliberately, and each has a test:

- The **task-runner fallback** now keys off whether a language ecosystem produced a _verifying_
  check, not merely whether one was detected; otherwise a `package.json`-with-no-scripts repo
  would suppress its own `make test`.
- A non-verifying group **consumes none of the `VALIDATION_MAX_CHECKS` budget**, so it cannot
  push a real check out.
- `truncated` counts **only the cap**. A group dropped for verifying nothing was never a
  suggestion, so counting it would report a truncation that discarded no check.

## Consequences

- **An image bump.** The harness gained `src/dependency-install.ts` and a call in every
  checkout-having mode, so the runner image and its four pinned tags move together (see
  CONTRIBUTING / CLAUDE.md).
- **Installed artifacts are hidden from git.** The paths the install adds are written to
  `.git/info/exclude`, computed by diffing the untracked paths either side of the run, so it is
  what the install actually materialised rather than a guess at directory names. Without it, a
  repo whose `.gitignore` does not cover its dependency directory opens a pull request containing
  the whole tree: the agent's `git add -A` cannot tell it did not put it there, and the
  conflict-resolution flow stages the whole tree unconditionally to finish its merge commit. The
  diff is what keeps this safe in the other direction: a `target/` the agent authored, or an
  untracked file already in a persistent checkout, is not the install's and is left visible.
- **No new report channel.** Prepopulation is setup, so it publishes no verdict: the outcome
  reaches the agent through its prompt and the operator through the harness log. When the install
  matters to the PR it is _also_ a validation check, and that path already reports.
- **The watchdog constraint applies.** A cold install is exactly the activity-silent phase
  `JOB_INACTIVITY_MS` (10 min) was never meant to judge, so the phase carries its own 30s
  heartbeat, like the frontend stand-up and the validation loop. Its own watchdog is a THIRD of
  the configured `JOB_MAX_DURATION_MS`: 20 min at the defaults, generous enough for a cold
  monorepo install, and bounded because the thing downstream that waits on it is the agent. It is
  derived rather than constant for the reason `git.ts` derives its per-command timeout: a number
  sized against a default silently breaks its own invariant when an operator changes that default.
  An explicit `DEPENDENCY_INSTALL_TIMEOUT_MS` is honoured but clamped by the same share.
- **It runs before the infra stand-up, not after.** The frontend stand-up installs and then serves
  what it built, so an install after it pays a second time and rewrites the `node_modules` the
  running app resolves out of. Prepopulation is setup for everything that follows it.
- **Ecosystems that cache in `HOME` get no reuse from `HARNESS_CLEAN_KEEP`.** That knob preserves
  paths _inside the checkout_ (`node_modules`, `.venv`, `target`), but Maven, Gradle, Go and Cargo
  cache in `~/.m2`, `~/.gradle`, `~/.cargo`, `GOMODCACHE`. A JVM repo therefore reinstalls from
  cold on every run even on a persistent checkout. Fixing that means a HOME- or volume-level
  cache, which collides with the "per-job state, NEVER HOME-global" rule and needs its own
  design; a read-mostly download cache is arguably fine, but it is not free to assume.
- **Cold-start cost on the ephemeral path.** Only the local transport sets `persistentCheckout`,
  so Cloudflare and runner-pool dispatches pay the install every run. That is the price of the
  agent seeing real dependencies; a warm cache for those paths is the natural follow-up.

## Status

Shipped, on EVERY checkout-having harness mode: single-repo coding (which the in-place fixers run
through), single-repo explore, the multi-repo explore fan-out, multi-repo coding, and conflict
resolution. Repo bootstrap is the sole exemption, and a principled one: its target repo is empty,
so there is no service config to resolve and nothing on disk to install from.

Every mode goes through the one `prepopulateDependencies` seam rather than assembling the
run/exclude/note steps itself, and `dependency-install.coverage.test.ts` asserts the rule
structurally: a harness function that calls `runAgentInWorkspace` must call
`prepopulateDependencies`, or be named in an exemption table with its reason. The first cut of
this feature wired three modes and missed two, and nothing in the build, the type system or the
test suite said so; that is what a structural guard is for.

Scoped to the PRIMARY checkout. A multi-repo run's peer and reference repos are cloned as siblings
and are not prepopulated, because the install is declared on ONE service frame (the primary
repo's), and a peer's own service declares a config this dispatch never resolved. Fanning the
primary's command out across them would run, say, `pnpm install` in a Go checkout. On the
multi-repo path the agent's cwd is the workspace root, so the prompt note names the sibling
directory the install actually ran in rather than saying "this checkout".

Prepopulating peers properly means resolving each peer's own frame config at dispatch and carrying
a per-leg install on the job body. That is a real follow-up, not a limitation to work around here.
