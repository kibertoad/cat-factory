# @cat-factory/cli

The bootstrap CLI for [cat-factory](https://github.com/kibertoad/cat-factory) — the Agent
Architecture Board. One command scaffolds a **local-mode deployment** you can run on your own
machine: a Node/local backend (`@cat-factory/local-server`) and the frontend SPA
(`@cat-factory/app`), mirroring the [`deploy/local`](../../../deploy/local) and
[`deploy/frontend`](../../../deploy/frontend) example deployments in this repo — but depending on
the **published** libraries, so the generated project stands alone outside the monorepo.

It does the fiddly setup for you:

- **Generates the crypto secrets** in the exact formats the server requires —
  `AUTH_SESSION_SECRET` (32 random bytes, hex) and `ENCRYPTION_KEY` (32 random bytes, base64).
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

## Usage

No install needed — run it with your package manager's runner:

```sh
npm  create @cat-factory/cli@latest      # or:
pnpm dlx @cat-factory/cli
npx  @cat-factory/cli
```

Interactive by default (powered by [`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts))
— it asks for the project name and app title, lets you pick the source-control provider and
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
  local/                   # backend — @cat-factory/local-server
    package.json
    src/main.ts            # one-line startLocal() entry
    docker-compose.yml     # local Postgres (creds derived from --db-url)
    tsconfig.json
    .env                   # generated, gitignored: DATABASE_URL, secrets, PAT, harness image
    .env.example           # documented template
  frontend/                # SPA — extends the @cat-factory/app Nuxt layer
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

You still need to:

- **Pull the executor image** the agent jobs run as: `docker pull ghcr.io/kibertoad/cat-factory-executor:latest`.
- **Configure at least one model provider** in `local/.env` (the simplest is Cloudflare Workers
  AI over REST: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`; or a direct vendor key like
  `ANTHROPIC_API_KEY`). Without one, no model is selectable and pipelines can't start.

The generated `README.md` repeats these steps with your chosen values, and links to the full
[local-mode docs](../../../deploy/local/README.md) (container-runtime matrix, repo linking, the
Tester's Docker-in-Docker / ephemeral environments, the warm container pool, etc.).

## Security notes

- The `.env` files hold secrets and are **gitignored** by the scaffolded `.gitignore`. Never
  commit them. If you scaffold into an existing git repo, the CLI **merges** the required ignore
  rules into your existing `.gitignore` rather than clobbering it.
- The pasted token is **not echoed** to the terminal.
- Keep `AUTH_SESSION_SECRET` and `ENCRYPTION_KEY` **stable**: regenerating the session secret
  forces a re-login, and regenerating the encryption key orphans every encrypted-at-rest
  credential.

## Programmatic API

The bin is a thin shell over the package's exported functions, which are pure and reusable:

```ts
import { buildPlan, generateSecrets, patCreationUrl } from '@cat-factory/cli'

const secrets = generateSecrets()
const files = buildPlan({ projectName: 'my-cats', /* … */ ...secrets })
// files: { path, content, secret? }[]  — write them wherever you like
```

See `src/index.ts` for the full surface (`bootstrap`, `parseArgs`, `buildLocalEnv`,
`buildGitignore`, `mergeGitignore`, the VCS URL helpers, …).
