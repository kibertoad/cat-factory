import { dirname, join, resolve } from 'node:path'
import { type CliOptions, OPTION_DEFAULTS } from './args.js'
import { buildLocalEnv } from './env.js'
import { ALL_NATIVE_HARNESSES, NATIVE_HARNESS_INFO } from './execution.js'
import { type FileSystem, realFs } from './fs.js'
import { createConsoleIo, type Io } from './io.js'
import {
  type ExecutionChoice,
  resolveContainerRuntime,
  resolveExecution,
  resolveProvider,
  resolveSecrets,
  resolveToken,
} from './resolve.js'
import { type RandomBytes } from './secrets.js'
import { patEnvVar, providerLabel, type VcsProvider } from './vcs.js'

/** Injectable seams so the whole flow is driveable by fakes in tests. */
export interface EnvCommandDeps {
  io?: Io
  fs?: FileSystem
  cwd?: string
  randomBytes?: RandomBytes
}

export class EnvCommandError extends Error {}

/**
 * Generate a ready-to-run local-mode `.env` (and nothing else). Unlike `init` (which scaffolds a
 * whole project), this writes ONE `.env` into the target directory (default: the cwd), populated
 * so `@cat-factory/local-server` boots with no manual edits: all three required crypto secrets
 * (`AUTH_SESSION_SECRET`, `ENCRYPTION_KEY`, `HARNESS_SHARED_SECRET`) generated in the server's
 * required formats, the chosen VCS PAT (minted via the pre-scoped browser flow), and the
 * execution mode (prewarmed Docker pool vs native host agents). Model-provider keys are left as
 * commented hints — they are added through the UI after boot, so the file is runnable without
 * them. Returns the absolute path of the written `.env`.
 */
export async function generateEnv(options: CliOptions, deps: EnvCommandDeps = {}): Promise<string> {
  const io = deps.io ?? createConsoleIo()
  const fs = deps.fs ?? realFs
  const cwd = deps.cwd ?? process.cwd()

  io.info('\ncat-factory — generate a ready-to-run local-mode .env\n')

  const outDir = resolve(cwd, options.dir ?? '.')
  const envPath = join(outDir, '.env')
  // A `.env` holds secrets — never clobber an existing one silently. Refuse loudly (with the
  // --force escape hatch) rather than overwrite generated secrets a developer is relying on.
  if (fs.existsSync(envPath) && !options.force) {
    throw new EnvCommandError(`${envPath} already exists — pass --force to overwrite it.`)
  }

  const provider = await resolveProvider(options, io)
  const databaseUrl =
    options.databaseUrl ??
    (options.yes
      ? OPTION_DEFAULTS.databaseUrl
      : await io.question('Postgres DATABASE_URL', OPTION_DEFAULTS.databaseUrl))
  const port = options.port ?? OPTION_DEFAULTS.port
  const harnessImage = options.harnessImage ?? OPTION_DEFAULTS.harnessImage
  const containerRuntime = await resolveContainerRuntime(options, io)
  const corsAllowedOrigins = 'http://localhost:3000'
  const execution = await resolveExecution(options, io)
  const token = await resolveToken(options, provider, io)
  const secrets = await resolveSecrets(options, io, deps.randomBytes)

  const content = buildLocalEnv({
    databaseUrl,
    authSessionSecret: secrets.authSessionSecret,
    encryptionKey: secrets.encryptionKey,
    harnessSharedSecret: secrets.harnessSharedSecret,
    harnessImage,
    port,
    corsAllowedOrigins,
    provider,
    containerRuntime,
    executionMode: execution.mode,
    nativeHarnesses: execution.nativeHarnesses,
    harnessEntry: execution.harnessEntry,
    token,
  })

  fs.mkdirSync(dirname(envPath), { recursive: true })
  fs.writeFileSync(envPath, content)
  io.info(`\nWrote ${envPath}  (secret — gitignore it, never commit it)`)

  printNextSteps(io, {
    envPath,
    provider,
    port,
    tokenProvided: token !== '',
    execution,
  })
  return envPath
}

interface NextStepsInput {
  envPath: string
  provider: VcsProvider
  port: number
  tokenProvided: boolean
  execution: ExecutionChoice
}

function printNextSteps(io: Io, input: NextStepsInput): void {
  const lines = [
    '',
    'Done. Your local-mode .env is ready to run:',
    '',
    '  # from the deployment dir that holds this .env (e.g. deploy/local)',
    '  npm run db:up      # start local Postgres (docker compose)',
    '  npm start          # migrate + serve the API on :' + String(input.port),
    '',
    'Reminders:',
    `  - Pull the executor image:  docker pull ${OPTION_DEFAULTS.harnessImage}`,
    '  - No model-provider key is needed to boot — add providers/keys in the UI after sign-in',
    '    (or uncomment CLOUDFLARE_* / ANTHROPIC_API_KEY / OPENAI_API_KEY in the .env).',
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
      `  - Set your ${providerLabel(input.provider)} token (${patEnvVar(input.provider)}) in the ` +
        '.env before running agents.',
    )
  }
  lines.push('  - The .env holds secrets and must stay gitignored — never commit it.')
  io.info(lines.join('\n'))
}
