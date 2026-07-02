// Static file templates for the scaffolded deployment. These mirror `deploy/local` and
// `deploy/frontend` in this repo, but depend on the PUBLISHED libraries (not `workspace:*`) so
// the generated project works standalone outside the monorepo.

// Pinned library versions the scaffolded project depends on. Pinned (not the `latest` dist-tag)
// so a scaffold is reproducible and the backend/frontend can't resolve to skewed releases. These
// are `0.x` libraries, so the caret only picks up in-range PATCH releases (`^0.33.0` allows
// `0.33.x` but NOT `0.34.0`). A pin lagging a minor or two behind the library is fine — it just
// resolves to a slightly older, still-published release — so it does NOT need a refresh on every
// library bump. Refresh opportunistically (e.g. when cutting a CLI release) to keep scaffolds
// current. The one hard rule `templates.pins.test.ts` enforces: a pin must never point AHEAD of
// the current workspace version, because that references an unpublished release and makes the
// scaffold's `pnpm install` unresolvable. (The two libraries version independently.)
export const LOCAL_SERVER_VERSION = '^0.34.0'
export const APP_VERSION = '^0.66.0'
export const NUXT_VERSION = '^4.4.8'
export const TYPES_NODE_VERSION = '^26.0.1'
export const TYPESCRIPT_VERSION = '7.0.1-rc'
export const WRANGLER_VERSION = '^4.105.0'

/** Default executor-harness image agent jobs run as per-run containers. */
export const DEFAULT_HARNESS_IMAGE = 'ghcr.io/kibertoad/cat-factory-executor:latest'

/** The container runtimes the local facade understands (`LOCAL_CONTAINER_RUNTIME`). */
export const CONTAINER_RUNTIMES = ['docker', 'podman', 'orbstack', 'colima', 'apple'] as const
export type ContainerRuntime = (typeof CONTAINER_RUNTIMES)[number]

/**
 * How agent jobs execute in local mode:
 * - `pool`   — per-run Docker-family containers from the executor image, optionally kept
 *              warm in a pool (the default, isolated, works with every model).
 * - `native` — a host process driving the developer's OWN installed `claude` / `codex` CLI
 *              (`LOCAL_NATIVE_AGENTS`): ambient login, no container, no leased credential.
 */
export const EXECUTION_MODES = ['pool', 'native'] as const
export type ExecutionMode = (typeof EXECUTION_MODES)[number]

/** The subscription harnesses local mode can drive as a NATIVE host process (`LOCAL_NATIVE_AGENTS`). */
export const NATIVE_HARNESSES = ['claude-code', 'codex'] as const
export type NativeHarness = (typeof NATIVE_HARNESSES)[number]

export const localPackageJson = (projectName: string): string =>
  `${JSON.stringify(
    {
      name: `${projectName}-local`,
      version: '0.1.0',
      private: true,
      description: 'Local-mode backend deployment of @cat-factory/local-server.',
      type: 'module',
      engines: {
        // The entry (src/main.ts) runs via Node's TypeScript type stripping; --env-file-if-exists
        // also needs a recent Node. 24+ covers both.
        node: '>=24',
      },
      scripts: {
        start: 'node --env-file-if-exists=.env src/main.ts',
        dev: 'node --watch --env-file-if-exists=.env src/main.ts',
        'db:up': 'docker compose up -d postgres',
        'db:down': 'docker compose down',
      },
      dependencies: {
        '@cat-factory/local-server': LOCAL_SERVER_VERSION,
      },
      devDependencies: {
        '@types/node': TYPES_NODE_VERSION,
        typescript: TYPESCRIPT_VERSION,
      },
    },
    null,
    2,
  )}\n`

export const localMainTs = `// Local-mode backend entry point.
//
// Calls the reusable @cat-factory/local-server library's startLocal(): connect to the local
// Postgres (DATABASE_URL), run the schema migration, boot pg-boss + the durable execution
// worker, and serve the shared Hono app. Agent jobs run as per-run local containers and GitHub
// is reached via the PAT in .env. Node 24+ runs this TypeScript directly via type stripping
// (npm start = \`node --env-file-if-exists=.env src/main.ts\`), so edits here take effect with no
// build step.
import { startLocal } from '@cat-factory/local-server'

startLocal().catch((err: unknown) => {
  console.error('failed to start cat-factory local server:', err)
  process.exit(1)
})
`

export const dockerCompose = (dbUrl: string): string => {
  // Derive the compose credentials/db from the DATABASE_URL so the two always agree.
  let user = 'cat'
  let password = 'cat'
  let db = 'catfactory'
  let port = '5432'
  try {
    const u = new URL(dbUrl)
    user = decodeURIComponent(u.username) || user
    password = decodeURIComponent(u.password) || password
    db = u.pathname.replace(/^\//, '') || db
    port = u.port || port
  } catch {
    // Keep the defaults if the URL doesn't parse.
  }
  return `# Local Postgres for the cat-factory backend. The orchestrator itself runs on the host
# (so it can drive the container runtime to spawn agent containers), so only Postgres lives here.
#
#   docker compose up -d postgres   # or: pnpm db:up
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_USER: ${user}
      POSTGRES_PASSWORD: ${password}
      POSTGRES_DB: ${db}
    ports:
      - '${port}:5432'
    volumes:
      - cat-factory-pg:/var/lib/postgresql
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${user} -d ${db}']
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  cat-factory-pg:
`
}

/** Non-secret inputs shown in `local/.env.example`, kept in sync with the populated `.env`. */
export interface LocalEnvExampleInput {
  provider?: 'github' | 'gitlab'
  containerRuntime?: ContainerRuntime
  databaseUrl?: string
  port?: number
  harnessImage?: string
  executionMode?: ExecutionMode
  nativeHarnesses?: NativeHarness[]
}

export const localEnvExample = (input: LocalEnvExampleInput = {}): string => {
  const {
    provider = 'github',
    containerRuntime = 'docker',
    databaseUrl = 'postgres://cat:cat@localhost:5432/catfactory',
    port = 8787,
    harnessImage = DEFAULT_HARNESS_IMAGE,
    executionMode = 'pool',
    nativeHarnesses,
  } = input
  // Show the chosen provider's PAT var active and the other commented, so the example matches
  // the populated `.env` the CLI writes for that provider.
  const tokenLines =
    provider === 'gitlab' ? ['# GITHUB_PAT=', 'GITLAB_PAT='] : ['GITHUB_PAT=', '# GITLAB_PAT=']
  // Mirror the execution mode: native shows LOCAL_NATIVE_AGENTS + LOCAL_HARNESS_ENTRY active;
  // pool shows them commented (with the warm-pool pointer to the UI).
  const nativeList = nativeHarnesses?.length ? nativeHarnesses.join(',') : 'claude-code,codex'
  const executionLines =
    executionMode === 'native'
      ? [
          '# Execution mode: NATIVE host agents — steps whose model maps to a native vendor',
          '# (Claude via claude-code, ChatGPT via codex) run as a host process driving your own',
          '# installed CLI. Every other model still runs in a container (LOCAL_HARNESS_IMAGE).',
          `LOCAL_NATIVE_AGENTS=${nativeList}`,
          '# REQUIRED for native mode: the executor-harness server entry path.',
          'LOCAL_HARNESS_ENTRY=',
        ]
      : [
          '# Execution mode: PREWARMED DOCKER POOL — per-run containers from LOCAL_HARNESS_IMAGE.',
          '# Warm-pool sizing lives in the UI (Integrations > "Local mode"); recommended: size 3,',
          '# pre-warm 1, idle 10m. To switch to native host agents instead, set these two:',
          '# LOCAL_NATIVE_AGENTS=claude-code,codex',
          '# LOCAL_HARNESS_ENTRY=',
        ]
  return `# Example env for the local-mode backend. Copy to \`.env\` (gitignored) and fill in.
# \`cat-factory init\` generates a populated \`.env\` for you; this is the documented template
# (the non-secret values below mirror the ones you chose at scaffold time).
DATABASE_URL=${databaseUrl}
PORT=${port}
CORS_ALLOWED_ORIGINS=http://localhost:3000
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
AUTH_SESSION_SECRET=
# Generate with: openssl rand -base64 32
ENCRYPTION_KEY=
# A GitHub (classic, scopes: repo,workflow) or GitLab (scope: api,read_user) personal access token.
${tokenLines.join('\n')}
# For a self-managed GitLab instance, also set GITLAB_API_BASE (e.g. https://gitlab.example.com/api/v4).
# GITLAB_API_BASE=
LOCAL_HARNESS_IMAGE=${harnessImage}
# Container runtime that spawns agent jobs: ${CONTAINER_RUNTIMES.join(' | ')}.
LOCAL_CONTAINER_RUNTIME=${containerRuntime}
${executionLines.join('\n')}
# At least one model provider (Cloudflare Workers AI over REST shown; or a direct vendor key):
# CLOUDFLARE_ACCOUNT_ID=
# CLOUDFLARE_API_TOKEN=
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
`
}

export const frontendPackageJson = (projectName: string): string =>
  `${JSON.stringify(
    {
      name: `${projectName}-frontend`,
      version: '0.1.0',
      private: true,
      description: 'Frontend SPA deployment — extends the @cat-factory/app Nuxt layer.',
      type: 'module',
      scripts: {
        postinstall: 'nuxt prepare',
        dev: 'nuxt dev',
        build: 'nuxt build',
        generate: 'nuxt generate',
        preview: 'nuxt preview',
        deploy: 'wrangler pages deploy',
      },
      dependencies: {
        '@cat-factory/app': APP_VERSION,
        nuxt: NUXT_VERSION,
      },
      devDependencies: {
        typescript: '^6.0.3',
        'vue-tsc': '^3.3.5',
        wrangler: WRANGLER_VERSION,
      },
    },
    null,
    2,
  )}\n`

export const frontendNuxtConfig = (title: string): string =>
  `// Frontend deployment — a thin Nuxt app that consumes the @cat-factory/app layer.
// All SPA logic lives in the layer; this app only \`extends\` it and applies branding.
// The backend URL is baked in at BUILD time from NUXT_PUBLIC_API_BASE (the SPA is ssr: false).
export default defineNuxtConfig({
  extends: ['@cat-factory/app'],

  app: {
    head: {
      title: ${JSON.stringify(title)},
    },
  },
})
`

export const frontendWranglerToml = (projectName: string): string =>
  `# Cloudflare Pages config for the frontend SPA.
#
# The SPA's backend URL is baked in at BUILD time (NUXT_PUBLIC_API_BASE), NOT here — Pages
# [vars] only reach Functions at runtime and this is a pure static SPA. Change \`name\` to your
# own Pages project.
name = "${projectName}-frontend"
pages_build_output_dir = ".output/public"
compatibility_date = "2025-06-01"
`

export const frontendEnvExample = (apiBase = 'http://localhost:8787'): string =>
  `# Example env for the frontend SPA. Copy to \`.env\` (gitignored).
# Base URL of the backend API, baked in at build time (mirrors your chosen --api-base/--port).
NUXT_PUBLIC_API_BASE=${apiBase}
`

export const tsconfigJson = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
`
