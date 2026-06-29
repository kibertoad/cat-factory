import { CONTAINER_RUNTIMES, type ContainerRuntime, DEFAULT_HARNESS_IMAGE } from './templates.js'
import { VCS_PROVIDERS, type VcsProvider } from './vcs.js'

/** Parsed, validated CLI options. Unset optionals are resolved later (defaults / prompts). */
export interface CliOptions {
  /** The subcommand. Only `init` exists today; the default when omitted. */
  command: 'init' | 'help' | 'version'
  dir?: string
  projectName?: string
  appTitle?: string
  provider?: VcsProvider
  token?: string
  databaseUrl?: string
  apiBase?: string
  port?: number
  harnessImage?: string
  /** Container runtime that spawns agent jobs (`LOCAL_CONTAINER_RUNTIME`). */
  containerRuntime?: ContainerRuntime
  /** Skip opening the browser at the token-creation URL (still prints it). */
  noOpen: boolean
  /** Non-interactive: never prompt; use defaults/flags. Fails if a required value is missing. */
  yes: boolean
  /** Overwrite existing files instead of refusing. */
  force: boolean
}

const DEFAULTS = {
  noOpen: false,
  yes: false,
  force: false,
} as const

export class ArgError extends Error {}

/** Parse `process.argv.slice(2)` into {@link CliOptions}. Throws {@link ArgError} on bad input. */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { command: 'init', ...DEFAULTS }
  let commandSet = false

  const takeValue = (flag: string, inline: string | undefined, rest: string[]): string => {
    if (inline !== undefined) return inline
    const next = rest.shift()
    if (next === undefined) throw new ArgError(`Missing value for ${flag}`)
    return next
  }

  const queue = [...argv]
  while (queue.length > 0) {
    const raw = queue.shift() as string
    const eq = raw.indexOf('=')
    const flag = raw.startsWith('--') && eq !== -1 ? raw.slice(0, eq) : raw
    const inline = raw.startsWith('--') && eq !== -1 ? raw.slice(eq + 1) : undefined

    switch (flag) {
      case 'init':
        if (!commandSet) {
          opts.command = 'init'
          commandSet = true
        }
        break
      case 'help':
      case '--help':
      case '-h':
        opts.command = 'help'
        commandSet = true
        break
      case 'version':
      case '--version':
      case '-v':
        opts.command = 'version'
        commandSet = true
        break
      case '--dir':
      case '-d':
        opts.dir = takeValue(flag, inline, queue)
        break
      case '--name':
        opts.projectName = takeValue(flag, inline, queue)
        break
      case '--title':
        opts.appTitle = takeValue(flag, inline, queue)
        break
      case '--provider':
        opts.provider = parseProvider(takeValue(flag, inline, queue))
        break
      case '--token':
        opts.token = takeValue(flag, inline, queue)
        break
      case '--db-url':
        opts.databaseUrl = takeValue(flag, inline, queue)
        break
      case '--api-base':
        opts.apiBase = takeValue(flag, inline, queue)
        break
      case '--port':
        opts.port = parsePort(takeValue(flag, inline, queue))
        break
      case '--harness-image':
        opts.harnessImage = takeValue(flag, inline, queue)
        break
      case '--container-runtime':
        opts.containerRuntime = parseContainerRuntime(takeValue(flag, inline, queue))
        break
      case '--no-open':
        opts.noOpen = true
        break
      case '--yes':
      case '-y':
        opts.yes = true
        break
      case '--force':
      case '-f':
        opts.force = true
        break
      default:
        throw new ArgError(`Unknown argument: ${raw}`)
    }
  }
  return opts
}

function parseProvider(value: string): VcsProvider {
  const v = value.toLowerCase()
  if ((VCS_PROVIDERS as readonly string[]).includes(v)) return v as VcsProvider
  throw new ArgError(`Invalid --provider "${value}" (expected: ${VCS_PROVIDERS.join(' | ')})`)
}

function parseContainerRuntime(value: string): ContainerRuntime {
  const v = value.toLowerCase()
  if ((CONTAINER_RUNTIMES as readonly string[]).includes(v)) return v as ContainerRuntime
  throw new ArgError(
    `Invalid --container-runtime "${value}" (expected: ${CONTAINER_RUNTIMES.join(' | ')})`,
  )
}

function parsePort(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ArgError(`Invalid --port "${value}" (expected an integer 1-65535)`)
  }
  return n
}

/** Resolved default values for any option the user didn't supply. */
export const OPTION_DEFAULTS = {
  projectName: 'cat-factory',
  appTitle: 'Agent Architecture Board',
  provider: 'github' as VcsProvider,
  databaseUrl: 'postgres://cat:cat@localhost:5432/catfactory',
  apiBase: 'http://localhost:8787',
  port: 8787,
  harnessImage: DEFAULT_HARNESS_IMAGE,
  containerRuntime: 'docker' as ContainerRuntime,
} as const

export const HELP_TEXT = `cat-factory — bootstrap a local cat-factory deployment

Usage:
  cat-factory [init] [options]

Scaffolds a local-mode backend (local/) and frontend SPA (frontend/), generates the
crypto secrets, mints a GitHub/GitLab personal access token (opens your browser), and
writes gitignored .env files.

Options:
  -d, --dir <path>        Target directory (default: ./<name>)
      --name <name>       Project name slug (default: cat-factory)
      --title <title>     Frontend app title (default: Agent Architecture Board)
      --provider <p>      Source control: github | gitlab (default: github)
      --token <token>     PAT value (skips the browser/paste flow)
      --db-url <url>      Postgres DATABASE_URL
      --api-base <url>   Backend API base for the SPA (default: http://localhost:<port>)
      --port <n>          Backend HTTP port (default: 8787; also sets the SPA's api-base)
      --harness-image <ref>  Executor-harness image (default: ghcr.io ...:latest)
      --container-runtime <r>  Agent container runtime: docker | podman | orbstack | colima | apple
      --no-open           Don't open the browser (just print the token URL)
  -y, --yes               Non-interactive: use defaults/flags, never prompt
  -f, --force             Overwrite existing files
  -h, --help              Show this help
  -v, --version           Show the CLI version
`
