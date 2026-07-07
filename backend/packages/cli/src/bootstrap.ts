import { dirname, join, resolve } from 'node:path'
import { type CliOptions, OPTION_DEFAULTS } from './args.js'
import { ALL_NATIVE_HARNESSES, NATIVE_HARNESS_INFO } from './execution.js'
import { type FileSystem, realFs } from './fs.js'
import { createConsoleIo, type Io } from './io.js'
import { buildPlan, type PlannedFile } from './plan.js'
import {
  type ExecutionChoice,
  resolveContainerRuntime,
  resolveExecution,
  resolveProvider,
  resolveSecrets,
  resolveToken,
} from './resolve.js'
import { type RandomBytes } from './secrets.js'
import { slugifyProjectName } from './slug.js'
import { providerLabel, type VcsProvider } from './vcs.js'

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

  const rawProjectName =
    options.projectName ??
    (options.yes
      ? OPTION_DEFAULTS.projectName
      : await io.question('Project name', OPTION_DEFAULTS.projectName))

  // The name is used verbatim as the generated packages' npm `name`, so it must be a valid slug.
  const projectName = slugifyProjectName(rawProjectName, OPTION_DEFAULTS.projectName)
  if (projectName !== rawProjectName) {
    io.warn(`Using "${projectName}" as the project slug (npm package names must be lowercased).`)
  }

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

  // Resolve the port first: the SPA's api-base defaults to it, so a non-default --port can't
  // silently leave the frontend pointed at the wrong backend.
  const port = options.port ?? OPTION_DEFAULTS.port
  const defaultApiBase = `http://localhost:${port}`
  const apiBase =
    options.apiBase ??
    (options.yes
      ? defaultApiBase
      : await io.question('Backend API base (for the SPA)', defaultApiBase))

  const harnessImage = options.harnessImage ?? OPTION_DEFAULTS.harnessImage
  const containerRuntime = await resolveContainerRuntime(options, io)
  const corsAllowedOrigins = 'http://localhost:3000'

  const execution = await resolveExecution(options, io)

  const token = await resolveToken(options, provider, io)

  const secrets = await resolveSecrets(options, io, deps.randomBytes)

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
    containerRuntime,
    executionMode: execution.mode,
    nativeHarnesses: execution.nativeHarnesses,
    harnessEntry: execution.harnessEntry,
    authSessionSecret: secrets.authSessionSecret,
    encryptionKey: secrets.encryptionKey,
    harnessSharedSecret: secrets.harnessSharedSecret,
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
    execution,
    alreadyGitRepo: fs.existsSync(join(targetDir, '.git')),
  })
  return targetDir
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
  /** The resolved execution mode, so the reminders match how agents will run. */
  execution: ExecutionChoice
  /** Whether the target dir is already a git repo (skip the `git init` nudge if so). */
  alreadyGitRepo: boolean
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
  if (input.execution.mode === 'native') {
    const clis = (input.execution.nativeHarnesses ?? [...ALL_NATIVE_HARNESSES])
      .map((h) => NATIVE_HARNESS_INFO[h].cli)
      .join(' / ')
    lines.push(
      `  - Native mode: install + log in to the ${clis} CLI on this host (the harness server`,
      '    is bundled; the image above still runs non-native steps).',
    )
  } else {
    lines.push(
      '  - Warm pool (faster starts) is optional — configure it in the UI under Integrations >',
      '    "Local mode" (recommended to start: size 3, pre-warm 1).',
    )
  }
  if (!input.tokenProvided) {
    lines.push(
      `  - Set your ${providerLabel(input.provider)} token in local/.env before running agents.`,
    )
  }
  lines.push(
    '  - local/.env and frontend/.env hold secrets and are gitignored — never commit them.',
  )
  if (!input.alreadyGitRepo) {
    lines.push(
      `  - Not a git repo yet — run \`git init\` in ${input.targetDir} to start tracking (the`,
      '    generated .gitignore already keeps the .env secrets out).',
    )
  }
  io.info(lines.join('\n'))
}
