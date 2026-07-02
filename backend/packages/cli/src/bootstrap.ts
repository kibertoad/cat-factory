import * as nodeFs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { type CliOptions, OPTION_DEFAULTS } from './args.js'
import {
  ALL_NATIVE_HARNESSES,
  EXECUTION_MODE_TRADEOFFS,
  NATIVE_HARNESS_INFO,
  nativeModelsFor,
} from './execution.js'
import { createConsoleIo, type Io } from './io.js'
import { buildPlan, type PlannedFile } from './plan.js'
import { generateSecrets, type GeneratedSecrets, type RandomBytes } from './secrets.js'
import { slugifyProjectName } from './slug.js'
import {
  CONTAINER_RUNTIMES,
  type ContainerRuntime,
  EXECUTION_MODES,
  type ExecutionMode,
  type NativeHarness,
} from './templates.js'
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

async function resolveProvider(options: CliOptions, io: Io): Promise<VcsProvider> {
  if (options.provider) return options.provider
  if (options.yes) return OPTION_DEFAULTS.provider
  return io.select(
    'Source control',
    VCS_PROVIDERS.map((value) => ({ value, label: providerLabel(value) })),
    OPTION_DEFAULTS.provider,
  )
}

async function resolveContainerRuntime(options: CliOptions, io: Io): Promise<ContainerRuntime> {
  if (options.containerRuntime) return options.containerRuntime
  if (options.yes) return OPTION_DEFAULTS.containerRuntime
  return io.select(
    'Container runtime that spawns agent jobs',
    CONTAINER_RUNTIMES.map((value) => ({ value, label: value })),
    OPTION_DEFAULTS.containerRuntime,
  )
}

/** The resolved execution configuration threaded into the plan. */
interface ExecutionChoice {
  mode: ExecutionMode
  nativeHarnesses?: NativeHarness[]
  harnessEntry?: string
}

/**
 * Resolve how agent jobs execute — a prewarmed Docker pool (default) or native host agents —
 * plus, for native mode, which harnesses run natively and the harness server entry path. In
 * interactive mode the tradeoffs of each mode are printed before the choice, and (native only)
 * the developer can list which models actually run natively before committing.
 */
/** Whether any native-only flag (`--native-harnesses` / `--harness-entry`) was supplied. */
function nativeFlagsProvided(options: CliOptions): boolean {
  return Boolean(options.nativeHarnesses?.length) || options.harnessEntry !== undefined
}

async function resolveExecution(options: CliOptions, io: Io): Promise<ExecutionChoice> {
  const mode = await resolveExecutionMode(options, io)
  if (mode !== 'native') {
    // Native-only flags carry no meaning in pool mode; warn rather than silently drop them so a
    // `--execution-mode pool --native-harnesses …` (or the same via prompt) isn't a quiet no-op.
    if (nativeFlagsProvided(options))
      io.warn(
        'Ignoring --native-harnesses / --harness-entry: they only apply to --execution-mode native.',
      )
    return { mode }
  }

  const nativeHarnesses = await resolveNativeHarnesses(options, io)
  if (!options.yes) await maybeShowNativeModels(io, nativeHarnesses)
  const harnessEntry = await resolveHarnessEntry(options, io)
  return { mode, nativeHarnesses, harnessEntry }
}

async function resolveExecutionMode(options: CliOptions, io: Io): Promise<ExecutionMode> {
  if (options.executionMode) return options.executionMode
  // A native-only flag with no explicit --execution-mode clearly means native: infer it rather
  // than defaulting to pool and dropping the flag on the floor.
  if (nativeFlagsProvided(options)) {
    io.info('Assuming --execution-mode native (a native-only flag was provided).')
    return 'native'
  }
  if (options.yes) return OPTION_DEFAULTS.executionMode
  // Print both modes' tradeoffs so the choice is informed, not a bare two-item menu.
  io.info(
    ['\nHow should agent jobs run locally?', '', ...EXECUTION_MODES.flatMap(tradeoffBlock)].join(
      '\n',
    ),
  )
  return io.select(
    'Execution mode',
    [
      { value: 'pool' as const, label: 'Prewarmed Docker pool (recommended)' },
      { value: 'native' as const, label: 'Native host agents (your own claude/codex CLI)' },
    ],
    OPTION_DEFAULTS.executionMode,
  )
}

/** Render one execution mode's tradeoff bullet block for the pre-prompt info. */
function tradeoffBlock(mode: ExecutionMode): string[] {
  return [...EXECUTION_MODE_TRADEOFFS[mode], '']
}

async function resolveNativeHarnesses(options: CliOptions, io: Io): Promise<NativeHarness[]> {
  if (options.nativeHarnesses?.length) return options.nativeHarnesses
  if (options.yes) return [...ALL_NATIVE_HARNESSES]
  const choice = await io.select(
    'Which installed CLI(s) should run agents natively?',
    [
      { value: 'both' as const, label: 'Both — Claude Code and Codex' },
      { value: 'claude-code' as const, label: NATIVE_HARNESS_INFO['claude-code'].label },
      { value: 'codex' as const, label: NATIVE_HARNESS_INFO.codex.label },
    ],
    'both',
  )
  return choice === 'both' ? [...ALL_NATIVE_HARNESSES] : [choice]
}

/** Offer to list the models that will actually run natively for the chosen harnesses. */
async function maybeShowNativeModels(io: Io, harnesses: NativeHarness[]): Promise<void> {
  const show = await io.confirm('List the models that will run natively in this mode?', true)
  if (!show) return
  const models = nativeModelsFor(harnesses)
  const lines = [
    '\nModels that run natively (through your ambient CLI):',
    ...models.map((m) => `  - ${m.label}  [id: ${m.id}]  via ${m.harness}`),
    '',
    'Any OTHER model a step selects (Cloudflare, direct keys, or GLM/Kimi/DeepSeek — which',
    'reuse the claude-code harness against their own endpoint) still runs in a container,',
    'so the executor image is still used for those steps.',
  ]
  io.info(lines.join('\n'))
}

/**
 * Resolve the executor-harness server entry path required for native mode. There is no
 * universal default (it depends where the harness source lives), so an unset value is left
 * blank in `.env` with a warning to fill it in before starting.
 */
async function resolveHarnessEntry(options: CliOptions, io: Io): Promise<string> {
  if (options.harnessEntry !== undefined) return options.harnessEntry
  if (options.yes) {
    // Non-interactive native mode with no --harness-entry: LOCAL_HARNESS_ENTRY is required, so
    // warn loudly here too (the interactive branch below already does) — otherwise the misconfig
    // only surfaces as a boot-time throw.
    io.warn(
      'LOCAL_HARNESS_ENTRY left blank (native mode, --yes with no --harness-entry) — set it ' +
        'before starting or native dispatch fails.',
    )
    return ''
  }
  const entry = (
    await io.question(
      'Path to the executor-harness server entry (LOCAL_HARNESS_ENTRY; leave blank to set later)',
    )
  ).trim()
  if (entry === '')
    io.warn('LOCAL_HARNESS_ENTRY left blank — set it before starting or native dispatch fails.')
  return entry
}

/**
 * Resolve the two mandatory crypto secrets. By default (and always in `--yes` mode) they are
 * generated for the developer in the server's required formats. Interactively the developer can
 * decline (e.g. to paste their own), leaving them blank with a note on how to fill them in.
 */
async function resolveSecrets(
  options: CliOptions,
  io: Io,
  randomBytes: RandomBytes | undefined,
): Promise<GeneratedSecrets> {
  const generate =
    options.yes ||
    (await io.confirm('Generate AUTH_SESSION_SECRET and ENCRYPTION_KEY for you?', true))
  if (!generate) {
    io.warn(
      'Left AUTH_SESSION_SECRET / ENCRYPTION_KEY blank — fill them in before starting ' +
        '(see local/.env.example for the generate commands). Keep both stable once set.',
    )
    return { authSessionSecret: '', encryptionKey: '' }
  }
  const secrets = generateSecrets(randomBytes)
  io.info('\nGenerated AUTH_SESSION_SECRET (hex) and ENCRYPTION_KEY (base64).')
  return secrets
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
      `  - Native mode: install + log in to the ${clis} CLI on this host, and set`,
      '    LOCAL_HARNESS_ENTRY in local/.env (the image above still runs non-native steps).',
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
