# @cat-factory/cli

The bootstrap CLI for [cat-factory](https://github.com/kibertoad/cat-factory), the Agent
Architecture Board. One command scaffolds a **local-mode deployment** you can run on your own
machine: a Node/local backend (`@cat-factory/local-server`) and the frontend SPA
(`@cat-factory/app`), mirroring the [`deploy/local`](../../../deploy/local) and
[`deploy/frontend`](../../../deploy/frontend) example deployments in this repo, but depending on
the **published** libraries, so the generated project stands alone outside the monorepo.

It does the fiddly setup for you:

- **Offers to generate the crypto secrets** in the exact formats the server requires:
  `AUTH_SESSION_SECRET` (32 random bytes, hex), `ENCRYPTION_KEY` (32 random bytes, base64) and
  `HARNESS_SHARED_SECRET` (32 random bytes, hex). All three are required to boot. On by default;
  decline to leave them blank and paste your own.
- **Lets you choose how agents run**: a **prewarmed Docker pool** (isolated per-run containers
  from the executor image, the default) or **native host agents** (a host process driving your
  own installed `claude`/`codex` CLI: no container, no leased credential, but no sandbox and only
  Claude/ChatGPT models go native). The tradeoffs of each are printed before you pick, and in
  native mode the CLI can list exactly which models will run natively.
- **Surfaces the commonly-useful optional settings** in `local/.env` with sane defaults
  (email/password sign-in, open signup, Langfuse tracing, Slack notifications, consensus, the
  boot-time image refresh), all commented so you toggle them in place instead of hunting the docs.
- **Mints a source-control token.** Pick GitHub or GitLab; the CLI opens your browser at the
  provider's "create a personal access token" page with the right **scopes pre-selected**
  (GitHub classic `repo,workflow`; GitLab `api`), then reads the token you paste back. Both
  providers are first-class in local mode: the token authenticates the agent containers' git
  clone/push, and the CI gate / mergeability / real merge / repo-link flows all run against the
  provider's real API (GitLab via `@cat-factory/gitlab`, GitHub via the PAT client). For a
  self-managed GitLab instance, set `GITLAB_API_BASE` in `local/.env`.
- **Populates and gitignores the `.env` files.** It writes `local/.env` (DB URL, the generated
  secrets, your PAT, the harness image) and `frontend/.env` (`NUXT_PUBLIC_API_BASE`), and writes
  (or merges into) a `.gitignore` so those secret files are never committed.

## Commands

- **`cat-factory init`** (the default): scaffolds the whole deployment (`local/` + `frontend/`),
  described above.
- **`cat-factory env`**: generates **only** a ready-to-run local-mode `.env` in the current
  directory (or `--dir`), using the same secret generation, PAT flow, and pool-vs-native choice.
  Use it when the deployment already exists (e.g. inside [`deploy/local`](../../../deploy/local),
  or an already-scaffolded project) and you just need a fresh, complete `.env`. It refuses to
  overwrite an existing `.env` unless you pass `--force`, and (like `init`) it creates or merges
  the target dir's `.gitignore` so the secret `.env` can never be committed. A model-provider key
  is **not** needed to boot; add providers/keys through the UI after sign-in (the `.env` leaves
  them as commented hints), so the generated file runs local mode with no manual edits.
- **`cat-factory k3s`**: guided local Kubernetes setup for ephemeral environments (see `--help`).
- **`cat-factory supervise`**: run a dev command under a self-healing watchdog (see
  [Supervising local dev](#supervising-local-dev)).

## Supervising local dev

`node --watch` **parks on crash**: it restarts the entry only on a _file change_, never on a
process exit. So when a laptop sleeps and the resume takes the Postgres connection with it, the
server dies, the watcher settles at "Waiting for file changes before restarting", and nothing is
left bound to the port. The wrapper PID is still alive and the ready banner scrolled past long ago,
so the stack **looks** healthy while the SPA reports only a generic "can't reach backend", and it
stays that way until somebody notices.

`cat-factory supervise` wraps that command and repairs it:

```sh
cat-factory supervise --compose-service postgres -- pnpm dev:raw
```

`--compose-dir` (default: `--dir`, itself defaulting to the current directory) is where the
`docker-compose.yml` lives: compose resolves its project file relative to the working directory, so
supervising from anywhere else needs it set.

- **Probes the real signal** every 10s: the port is listening _and_ `/health` answers 200. The two
  failure modes differ: a parked watcher leaves nothing bound, while a server that booted but lost
  its DB pool still holds the socket and only fails the HTTP check.
- **Notices a resume.** Timers don't fire while the host is suspended, so a tick arriving three
  intervals late means time jumped. That triggers an immediate repair rather than waiting out the
  normal failure threshold: a resume is exactly when the stack is most likely already dead.
- **Restores dependencies before restarting.** `--compose-service postgres` brings the database
  back (the example compose files set no restart policy, so anything that stops the container
  engine leaves it down) and waits for it to report healthy, because relaunching against a
  still-initialising database just crashes again in `migrate`.
- **Revives a stopped local cluster.** `--k3s-cluster <name>` starts a k3d/kind cluster that is
  merely stopped and waits for its apiserver, so a slept laptop doesn't leave the Local k3s
  environment handler pointing at a dead control plane.
- **Notices a child that simply died.** A dead process handle is authoritative, so it repairs on the
  next probe instead of counting failures against a process that no longer exists.
- **Reaps the port.** Killing the child tree usually suffices, but a package-manager wrapper killed
  without its subtree leaves the real `node` orphaned and holding the socket; the relaunch then
  dies with `EADDRINUSE`, turning one outage into a restart loop. Reaping by port means SIGKILLing a
  process it was never handed, so every kill **names** the pid and the command behind it, and it only
  ever runs once the supervisor's own child is confirmed dead.

Two failures it deliberately does **not** retry, because retrying either would reproduce the exact
pathology this command exists to end, a restart loop that reads as progress:

- **A cluster wedged by a stale cgroup** (`runc create failed: … cgroup.procs: device or resource
busy`, a state a suspend can leave behind). Clearing that needs the container **engine** restarted,
  which would kill every other container, including the database the supervisor depends on. Reported
  once, with the fix.
- **A supervised command that never serves.** Restarts that fail to reach a serving state are capped
  (5 by default); hitting the cap reports why and exits **non-zero**. A command that is broken (a
  syntax error, a missing binary, a port something else owns) cannot be repaired by killing it again.
  Any successful probe resets the count, so a long-lived stack that has been repaired often is never
  capped.

`--runtime k3s` is **refused** alongside `--k3s-cluster`: a k3s host service has no containers for
this command to start, and quietly treating it as k3d would report "not ready, will retry" forever
without naming the real reason.

Prefer the unsupervised script when you are **debugging a crash**: the supervisor's job is to
restart the process, which destroys the parked state you would be trying to read.

Run `cat-factory supervise --help` for the full flag list (`--port`, `--health-path`, `--poll`,
`--boot-grace`, `--failures`, `--runtime`).

## Usage

No install needed; run it with your package manager's runner:

```sh
npm  create @cat-factory/cli@latest      # or:
pnpm dlx @cat-factory/cli
npx  @cat-factory/cli
```

Interactive by default (powered by [`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts)):
it asks for the project name and app title, lets you pick the source-control provider and
container runtime from a menu, asks for the database URL and API base, opens the browser to create
the token, and reads it back via a masked password prompt. Ctrl-C cancels cleanly at any step.

### Non-interactive

Drive it entirely with flags (handy for scripts / CI):

```sh
npx @cat-factory/cli init \
  --yes \
  --dir my-cats \
  --provider github \
  --token "$GITHUB_PAT" \
  --db-url "postgres://cat:cat@localhost:5432/catfactory" \
  --api-base "http://localhost:8787"
```

### Options

| Flag                      | Default                                 | Meaning                                                       |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| `-d, --dir <path>`        | `./<name>`                              | Target directory.                                             |
| `--name <name>`           | `cat-factory`                           | Project name slug (used for the scaffolded names).            |
| `--title <title>`         | `Agent Architecture Board`              | Frontend app title.                                           |
| `--provider <p>`          | `github`                                | Source control: `github` or `gitlab`.                         |
| `--token <token>`         | (prompted)                              | PAT value; skips the browser/paste flow.                      |
| `--db-url <url>`          | `postgres://cat:cat@…`                  | Postgres `DATABASE_URL`.                                      |
| `--api-base <url>`        | `http://localhost:<port>`               | Backend API base baked into the SPA.                          |
| `--port <n>`              | `8787`                                  | Backend HTTP port (also sets the SPA's api-base).             |
| `--harness-image <ref>`   | `ghcr.io/…/cat-factory-executor:latest` | Executor-harness image agent jobs run as.                     |
| `--container-runtime <r>` | `docker`                                | Agent runtime: `docker`/`podman`/`orbstack`/`colima`/`apple`. |
| `--execution-mode <m>`    | `pool`                                  | How agents run: `pool` (Docker pool) or `native` (host CLI).  |
| `--native-harnesses <l>`  | `claude-code,codex`                     | Native mode: harnesses to run natively (comma list).          |
| `--harness-entry <p>`     | (prompted)                              | Native mode: path to the executor-harness server entry.       |
| `--no-open`               | off                                     | Print the token URL but don't open the browser.               |
| `-y, --yes`               | off                                     | Non-interactive: use defaults/flags, never prompt.            |
| `-f, --force`             | off                                     | Overwrite existing files.                                     |
| `-h, --help`              |                                         | Show help.                                                    |
| `-v, --version`           |                                         | Show the CLI version.                                         |

## What it scaffolds

```
<dir>/
  .gitignore               # ignores .env / .env.* (keeps .env.example), build output
  README.md                # generated, project-specific run instructions
  local/                   # backend - @cat-factory/local-server
    package.json
    src/main.ts            # one-line startLocal() entry
    docker-compose.yml     # local Postgres (creds derived from --db-url)
    tsconfig.json
    .env                   # generated, gitignored: DATABASE_URL, secrets, PAT, harness image
    .env.example           # documented template
  frontend/                # SPA - extends the @cat-factory/app Nuxt layer
    package.json
    nuxt.config.ts
    wrangler.toml          # Cloudflare Pages config (optional deploy target)
    .env                   # generated, gitignored: NUXT_PUBLIC_API_BASE
    .env.example
```

### Running the scaffolded project

```sh
cd <dir>
# backend
cd local && npm install && npm run db:up && npm start     # serves :8787
# frontend (second terminal)
cd ../frontend && npm install && npm run dev              # Nuxt dev on :3000
```

The executor image agent jobs run in is **not** yours to fetch: the backend pulls the version
it was built against on first boot, so `LOCAL_HARNESS_IMAGE` stays unset in the generated
`.env` unless you passed `--harness-image` to pin one deliberately.

You still need to **configure at least one model provider** in `local/.env` (the simplest is
Cloudflare Workers AI over REST: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`; or a direct
vendor key like `ANTHROPIC_API_KEY`), or add one through the UI after signing in. The stack
boots without one, but no model is selectable and pipelines can't start.

The generated `README.md` repeats these steps with your chosen values, and links to the full
[local-mode docs](../../../deploy/local/README.md) (container-runtime matrix, repo linking, the
Tester's Docker-in-Docker / ephemeral environments, the warm container pool, etc.).

## Security notes

- The `.env` files hold secrets and are **gitignored** by the scaffolded `.gitignore`. Never
  commit them. If you scaffold into an existing git repo, the CLI **merges** the required ignore
  rules into your existing `.gitignore` rather than clobbering it.
- The pasted token is **not echoed** to the terminal.
- Keep `AUTH_SESSION_SECRET`, `ENCRYPTION_KEY` and `HARNESS_SHARED_SECRET` **stable**: regenerating
  the session secret forces a re-login, and regenerating the encryption key orphans every
  encrypted-at-rest credential.

## Programmatic API

The bin is a thin shell over the package's exported functions, which are pure and reusable:

```ts
import { buildPlan, generateSecrets, patCreationUrl } from '@cat-factory/cli'

const secrets = generateSecrets()
const files = buildPlan({ projectName: 'my-cats', /* … */ ...secrets })
// files: { path, content, secret? }[] - write them wherever you like
```

See `src/index.ts` for the full surface (`bootstrap`, `parseArgs`, `buildLocalEnv`,
`buildGitignore`, `mergeGitignore`, the VCS URL helpers, …).
