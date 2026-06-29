import * as nodeFs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { type CliOptions, OPTION_DEFAULTS } from './args.js'
import { createConsoleIo, type Io } from './io.js'
import { buildPlan, type PlannedFile } from './plan.js'
import { generateSecrets, type RandomBytes } from './secrets.js'
import { patCreationUrl, providerLabel, VCS_PROVIDERS, type VcsProvider } from './vcs.js'

/** The filesystem operations the writer needs — injectable so the flow is testable. */
export interface FileSystem {
  existsSync(path: string): boolean
  mkdirSync(path: string, options: { recursive: true }): void
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string): void
}

const realFs: FileSystem = {
  existsSync: (p) => nodeFs.existsSync(p),
  mkdirSync: (p, o) => {
    nodeFs.mkdirSync(p, o)
  },
  readFileSync: (p, e) => nodeFs.readFileSync(p, e),
  writeFileSync: (p, d) => {
    nodeFs.writeFileSync(p, d)
  },
}

export interface BootstrapDeps {
  io?: Io
  fs?: FileSystem
  cwd?: string
  randomBytes?: RandomBytes
}

export class BootstrapError extends Error {}

/** Run the interactive (or flag-driven) bootstrap. Returns the absolute project dir. */
export async function bootstrap(options: CliOptions, deps: BootstrapDeps = {}): Promise<string> {
  const io = deps.io ?? createConsoleIo()
  const fs = deps.fs ?? realFs
  const cwd = deps.cwd ?? process.cwd()

  io.info('\ncat-factory — scaffold a local deployment\n')

  const projectName =
    options.projectName ??
    (options.yes
      ? OPTION_DEFAULTS.projectName
      : await io.question('Project name', OPTION_DEFAULTS.projectName))

  const targetDir = resolve(cwd, options.dir ?? projectName)

  const appTitle =
    options.appTitle ??
    (options.yes
      ? OPTION_DEFAULTS.appTitle
      : await io.question('App title', OPTION_DEFAULTS.appTitle))

  const provider = await resolveProvider(options, io)

  const databaseUrl =
    options.databaseUrl ??
    (options.yes
      ? OPTION_DEFAULTS.databaseUrl
      : await io.question('Postgres DATABASE_URL', OPTION_DEFAULTS.databaseUrl))

  const apiBase =
    options.apiBase ??
    (options.yes
      ? OPTION_DEFAULTS.apiBase
      : await io.question('Backend API base (for the SPA)', OPTION_DEFAULTS.apiBase))

  const port = options.port ?? OPTION_DEFAULTS.port
  const harnessImage = options.harnessImage ?? OPTION_DEFAULTS.harnessImage
  const corsAllowedOrigins = 'http://localhost:3000'

  const token = await resolveToken(options, provider, io)

  const secrets = generateSecrets(deps.randomBytes)
  io.info('\nGenerated AUTH_SESSION_SECRET (hex) and ENCRYPTION_KEY (base64).')

  const gitignorePath = join(targetDir, '.gitignore')
  const existingGitignore = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : undefined

  const plan = buildPlan({
    projectName,
    appTitle,
    provider,
    token,
    databaseUrl,
    apiBase,
    port,
    corsAllowedOrigins,
    harnessImage,
    authSessionSecret: secrets.authSessionSecret,
    encryptionKey: secrets.encryptionKey,
    existingGitignore,
  })

  writePlan(plan, targetDir, fs, io, options.force)

  printNextSteps(io, {
    targetDir,
    projectName,
    provider,
    port,
    apiBase,
    tokenProvided: token !== '',
  })
  return targetDir
}

async function resolveProvider(options: CliOptions, io: Io): Promise<VcsProvider> {
  if (options.provider) return options.provider
  if (options.yes) return OPTION_DEFAULTS.provider
  const answer = (
    await io.question(`Source control (${VCS_PROVIDERS.join('/')})`, OPTION_DEFAULTS.provider)
  ).toLowerCase()
  if ((VCS_PROVIDERS as readonly string[]).includes(answer)) return answer as VcsProvider
  io.warn(`Unrecognized provider "${answer}", defaulting to ${OPTION_DEFAULTS.provider}.`)
  return OPTION_DEFAULTS.provider
}

/**
 * Resolve the PAT: an explicit `--token` wins; otherwise (interactive only) print the pre-scoped
 * creation URL, open the browser at it, and read the pasted token back. In `--yes` mode with no
 * token, leave it blank (the var is still written, present-but-empty).
 */
async function resolveToken(options: CliOptions, provider: VcsProvider, io: Io): Promise<string> {
  if (options.token !== undefined) return options.token
  if (options.yes) return ''

  const url = patCreationUrl(provider)
  const label = providerLabel(provider)
  io.info(`\nCreate a ${label} personal access token (scopes pre-selected):\n  ${url}`)

  if (!options.noOpen) {
    const open = await io.confirm('Open this URL in your browser now?', true)
    if (open) await io.openBrowser(url)
  }

  const token = await io.secret(`Paste your ${label} token here (or leave blank to add later)`)
  if (token === '')
    io.warn('No token entered — the var will be written blank; set it before running agents.')
  return token
}

function writePlan(
  plan: PlannedFile[],
  targetDir: string,
  fs: FileSystem,
  io: Io,
  force: boolean,
): void {
  io.info(`\nWriting to ${targetDir}`)
  for (const file of plan) {
    const abs = join(targetDir, file.path)
    // `.gitignore` is merged (existingGitignore folded in by buildPlan), so always (re)write it.
    const isMergeable = file.path === '.gitignore'
    if (fs.existsSync(abs) && !force && !isMergeable) {
      io.warn(`  skip  ${file.path} (exists; use --force to overwrite)`)
      continue
    }
    fs.mkdirSync(dirname(abs), { recursive: true })
    fs.writeFileSync(abs, file.content)
    io.info(`  write ${file.path}${file.secret ? '  (secret — gitignored)' : ''}`)
  }
}

interface NextStepsInput {
  targetDir: string
  projectName: string
  provider: VcsProvider
  port: number
  apiBase: string
  tokenProvided: boolean
}

function printNextSteps(io: Io, input: NextStepsInput): void {
  const lines = [
    '',
    'Done. Next steps:',
    '',
    `  cd ${input.targetDir}`,
    '  # backend',
    '  cd local && npm install && npm run db:up && npm start',
    '  # frontend (in a second terminal)',
    '  cd frontend && npm install && npm run dev',
    '',
    `  Backend API:  http://localhost:${input.port}`,
    '  Frontend SPA: http://localhost:3000',
    '',
    'Reminders:',
    `  - Pull the executor image:  docker pull ${OPTION_DEFAULTS.harnessImage}`,
    '  - Configure at least one model provider in local/.env (e.g. CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN).',
  ]
  if (!input.tokenProvided) {
    lines.push(
      `  - Set your ${providerLabel(input.provider)} token in local/.env before running agents.`,
    )
  }
  lines.push(
    '  - local/.env and frontend/.env hold secrets and are gitignored — never commit them.',
  )
  io.info(lines.join('\n'))
}
