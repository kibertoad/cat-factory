// Shared interactive resolvers — the prompt-or-flag logic that turns partial {@link CliOptions}
// into the concrete values a local-mode `.env` needs. Extracted from the `init` orchestrator so
// the `env` command (which writes only the `.env`, not a whole scaffold) reuses the SAME prompts
// rather than duplicating them. Every resolver is IO-seam driven, so the flows stay testable.
import { type CliOptions, OPTION_DEFAULTS } from './args.js'
import {
  ALL_NATIVE_HARNESSES,
  EXECUTION_MODE_TRADEOFFS,
  NATIVE_HARNESS_INFO,
  nativeModelsFor,
} from './execution.js'
import type { Io } from './io.js'
import { generateSecrets, type GeneratedSecrets, type RandomBytes } from './secrets.js'
import {
  CONTAINER_RUNTIMES,
  type ContainerRuntime,
  EXECUTION_MODES,
  type ExecutionMode,
  type NativeHarness,
} from './templates.js'
import { patCreationUrl, providerLabel, VCS_PROVIDERS, type VcsProvider } from './vcs.js'

export async function resolveProvider(options: CliOptions, io: Io): Promise<VcsProvider> {
  if (options.provider) return options.provider
  if (options.yes) return OPTION_DEFAULTS.provider
  return io.select(
    'Source control',
    VCS_PROVIDERS.map((value) => ({ value, label: providerLabel(value) })),
    OPTION_DEFAULTS.provider,
  )
}

export async function resolveContainerRuntime(
  options: CliOptions,
  io: Io,
): Promise<ContainerRuntime> {
  if (options.containerRuntime) return options.containerRuntime
  if (options.yes) return OPTION_DEFAULTS.containerRuntime
  return io.select(
    'Container runtime that spawns agent jobs',
    CONTAINER_RUNTIMES.map((value) => ({ value, label: value })),
    OPTION_DEFAULTS.containerRuntime,
  )
}

/** The resolved execution configuration threaded into the env. */
export interface ExecutionChoice {
  mode: ExecutionMode
  nativeHarnesses?: NativeHarness[]
  harnessEntry?: string
}

/** Whether any native-only flag (`--native-harnesses` / `--harness-entry`) was supplied. */
function nativeFlagsProvided(options: CliOptions): boolean {
  return Boolean(options.nativeHarnesses?.length) || options.harnessEntry !== undefined
}

/**
 * Resolve how agent jobs execute — a prewarmed Docker pool (default) or native host agents —
 * plus, for native mode, which harnesses run natively and the harness server entry path. In
 * interactive mode the tradeoffs of each mode are printed before the choice, and (native only)
 * the developer can list which models actually run natively before committing.
 */
export async function resolveExecution(options: CliOptions, io: Io): Promise<ExecutionChoice> {
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
 * Resolve the executor-harness server entry path for native mode. Optional: when left blank,
 * native mode defaults to the bundled `@cat-factory/executor-harness` (a dependency of
 * `@cat-factory/local-server`), so no configuration is needed. A value is only used to point at
 * a custom or source-checkout build.
 */
async function resolveHarnessEntry(options: CliOptions, io: Io): Promise<string> {
  if (options.harnessEntry !== undefined) return options.harnessEntry
  // Non-interactive (--yes): leave it blank; the bundled harness default kicks in at boot.
  if (options.yes) return ''
  return (
    await io.question(
      'Path to a custom executor-harness server entry (LOCAL_HARNESS_ENTRY; blank = bundled default)',
    )
  ).trim()
}

/**
 * Resolve the three mandatory crypto secrets. By default (and always in `--yes` mode) they are
 * generated for the developer in the server's required formats. Interactively the developer can
 * decline (e.g. to paste their own), leaving them blank with a note on how to fill them in.
 */
export async function resolveSecrets(
  options: CliOptions,
  io: Io,
  randomBytes: RandomBytes | undefined,
): Promise<GeneratedSecrets> {
  const generate =
    options.yes ||
    (await io.confirm(
      'Generate AUTH_SESSION_SECRET, ENCRYPTION_KEY and HARNESS_SHARED_SECRET for you?',
      true,
    ))
  if (!generate) {
    io.warn(
      'Left AUTH_SESSION_SECRET / ENCRYPTION_KEY / HARNESS_SHARED_SECRET blank — fill them in ' +
        'before starting (see .env.example for the generate commands). Keep all three stable once set.',
    )
    return { authSessionSecret: '', encryptionKey: '', harnessSharedSecret: '' }
  }
  const secrets = generateSecrets(randomBytes)
  io.info(
    '\nGenerated AUTH_SESSION_SECRET (hex), ENCRYPTION_KEY (base64) and HARNESS_SHARED_SECRET (hex).',
  )
  return secrets
}

/**
 * Resolve the PAT: an explicit `--token` wins; otherwise (interactive only) print the pre-scoped
 * creation URL, open the browser at it, and read the pasted token back. In `--yes` mode with no
 * token, leave it blank (the var is still written, present-but-empty).
 */
export async function resolveToken(
  options: CliOptions,
  provider: VcsProvider,
  io: Io,
): Promise<string> {
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
