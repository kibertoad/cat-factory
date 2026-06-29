import { buildFrontendEnv, buildLocalEnv } from './env.js'
import { buildGitignore, mergeGitignore } from './gitignore.js'
import {
  dockerCompose,
  frontendEnvExample,
  frontendNuxtConfig,
  frontendPackageJson,
  frontendWranglerToml,
  localEnvExample,
  localMainTs,
  localPackageJson,
  tsconfigJson,
} from './templates.js'
import { patCreationUrl, patEnvVar, providerLabel, type VcsProvider } from './vcs.js'

/** A single file the CLI will write, as a path relative to the project root + its content. */
export interface PlannedFile {
  path: string
  content: string
  /** True when the file holds secrets (it must always be gitignored, never overwritten blindly). */
  secret?: boolean
}

/** Everything the orchestrator needs to render the full project. Fully resolved (no prompting). */
export interface BootstrapInput {
  projectName: string
  appTitle: string
  provider: VcsProvider
  token: string
  databaseUrl: string
  apiBase: string
  port: number
  corsAllowedOrigins: string
  harnessImage: string
  authSessionSecret: string
  encryptionKey: string
  /** Existing root `.gitignore` content, if the target dir already has one (rules are merged in). */
  existingGitignore?: string
}

/** The complete, ordered set of files for a scaffolded project. Pure — fully testable. */
export function buildPlan(input: BootstrapInput): PlannedFile[] {
  const localEnv = buildLocalEnv({
    databaseUrl: input.databaseUrl,
    authSessionSecret: input.authSessionSecret,
    encryptionKey: input.encryptionKey,
    harnessImage: input.harnessImage,
    port: input.port,
    corsAllowedOrigins: input.corsAllowedOrigins,
    provider: input.provider,
    token: input.token,
  })
  const frontendEnv = buildFrontendEnv({ apiBase: input.apiBase })
  const gitignore =
    input.existingGitignore !== undefined
      ? mergeGitignore(input.existingGitignore)
      : buildGitignore()

  return [
    { path: '.gitignore', content: gitignore },
    { path: 'README.md', content: projectReadme(input) },

    // Local-mode backend.
    { path: 'local/package.json', content: localPackageJson(input.projectName) },
    { path: 'local/src/main.ts', content: localMainTs },
    { path: 'local/docker-compose.yml', content: dockerCompose(input.databaseUrl) },
    { path: 'local/tsconfig.json', content: tsconfigJson },
    { path: 'local/.env.example', content: localEnvExample },
    { path: 'local/.env', content: localEnv, secret: true },

    // Frontend SPA.
    { path: 'frontend/package.json', content: frontendPackageJson(input.projectName) },
    { path: 'frontend/nuxt.config.ts', content: frontendNuxtConfig(input.appTitle) },
    { path: 'frontend/wrangler.toml', content: frontendWranglerToml(input.projectName) },
    { path: 'frontend/.env.example', content: frontendEnvExample },
    { path: 'frontend/.env', content: frontendEnv, secret: true },
  ]
}

function projectReadme(input: BootstrapInput): string {
  const label = providerLabel(input.provider)
  const tokenVar = patEnvVar(input.provider)
  return `# ${input.appTitle}

A local-mode deployment of [cat-factory](https://github.com/kibertoad/cat-factory), scaffolded
with \`cat-factory init\`. It has two parts:

- **\`local/\`** — the backend (\`@cat-factory/local-server\`): the shared Hono app with
  Drizzle/Postgres + pg-boss, agent jobs run as per-run local containers, and ${label} reached
  via a personal access token.
- **\`frontend/\`** — the board SPA (extends the \`@cat-factory/app\` Nuxt layer).

> The \`.env\` files hold generated secrets (\`AUTH_SESSION_SECRET\`, \`ENCRYPTION_KEY\`) and your
> ${label} token (\`${tokenVar}\`). They are gitignored — **keep the values stable and never
> commit them.** Regenerating \`AUTH_SESSION_SECRET\` forces a re-login; regenerating
> \`ENCRYPTION_KEY\` orphans every encrypted credential.

## Prerequisites

- Node.js 24+ (the backend entry runs TypeScript via type stripping).
- A container runtime (Docker/Podman/OrbStack/Colima) for Postgres and the agent containers.
- The executor-harness image pulled locally:
  \`\`\`sh
  docker pull ${input.harnessImage}
  \`\`\`

## Install

\`\`\`sh
cd local && npm install && cd ../frontend && npm install && cd ..
\`\`\`

## Run the backend

\`\`\`sh
cd local
npm run db:up      # start local Postgres (docker compose)
npm start          # migrate + serve the API on :${input.port}
\`\`\`

At least one **model provider** must be configured or no model is selectable. The simplest is
Cloudflare Workers AI over REST — set \`CLOUDFLARE_ACCOUNT_ID\` + \`CLOUDFLARE_API_TOKEN\` in
\`local/.env\` (or a direct vendor key like \`ANTHROPIC_API_KEY\`), then restart.

## Run the frontend

\`\`\`sh
cd frontend
npm run dev        # Nuxt dev server on http://localhost:3000
\`\`\`

Open http://localhost:3000. \`NUXT_PUBLIC_API_BASE\` (in \`frontend/.env\`) points at
\`${input.apiBase}\`.

## Rotating the ${label} token

The token in \`local/.env\` (\`${tokenVar}\`) was minted at this URL with the right scopes
pre-selected:

    ${patCreationUrl(input.provider)}

To rotate it, create a new token there and paste-replace the value, then restart the backend.

## Linking a target repo

Agent steps resolve which repo to operate on from a projection seeded from the PAT. With
\`${tokenVar}\` set, the board's "Add from existing repo" button lists the repos the token can
access — pick one to create a service frame linked to that repo. See the
[local-mode docs](https://github.com/kibertoad/cat-factory/blob/main/deploy/local/README.md)
for the CLI \`link:repo\` alternative and the full container-runtime matrix.
`
}
