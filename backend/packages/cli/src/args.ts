import { CONTAINER_RUNTIMES, type ContainerRuntime, DEFAULT_HARNESS_IMAGE } from './templates.js'
import { VCS_PROVIDERS, type VcsProvider } from './vcs.js'

/** The Kubernetes distribution `cat-factory k3s` can provision/target. */
export const K3S_RUNTIMES = ['k3d', 'kind', 'k3s'] as const
export type K3sRuntime = (typeof K3S_RUNTIMES)[number]

/** Parsed, validated CLI options. Unset optionals are resolved later (defaults / prompts). */
export interface CliOptions {
  /** The subcommand. `init` (the default when omitted) or `k3s` (guided local-cluster setup). */
  command: 'init' | 'k3s' | 'help' | 'version'
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
  /** `k3s` command: name for a provisioned local cluster. */
  clusterName?: string
  /** `k3s` command: the Kubernetes distribution to provision/target. */
  k3sRuntime?: K3sRuntime
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
      case 'k3s':
        if (!commandSet) {
          opts.command = 'k3s'
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
      case '--cluster-name':
        opts.clusterName = takeValue(flag, inline, queue)
        break
      case '--runtime':
        opts.k3sRuntime = parseK3sRuntime(takeValue(flag, inline, queue))
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

function parseK3sRuntime(value: string): K3sRuntime {
  const v = value.toLowerCase()
  if ((K3S_RUNTIMES as readonly string[]).includes(v)) return v as K3sRuntime
  throw new ArgError(`Invalid --runtime "${value}" (expected: ${K3S_RUNTIMES.join(' | ')})`)
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
  // The SPA's API base has no standalone default: it is derived from `port`
  // (`http://localhost:<port>`) in bootstrap.ts so a custom --port can't leave the frontend
  // pointed at the wrong backend.
  port: 8787,
  harnessImage: DEFAULT_HARNESS_IMAGE,
  containerRuntime: 'docker' as ContainerRuntime,
  // `k3s` command defaults.
  k3sClusterName: 'cat-factory',
  k3sRuntime: 'k3d' as K3sRuntime,
} as const

export const HELP_TEXT = `cat-factory — bootstrap a local cat-factory deployment

Usage:
  cat-factory [init] [options]
  cat-factory k3s [options]

Commands:
  init   Scaffold a local-mode backend (local/) + frontend SPA (frontend/): generate the
         crypto secrets, mint a GitHub/GitLab PAT (opens your browser), write gitignored .env.
  k3s    Guided local Kubernetes setup: probe the host for a usable cluster and report what's
         found + recommended (provisioning + handler wiring land in a follow-up).

Options (init):
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

Options (k3s):
      --cluster-name <n>  Name for a provisioned local cluster (default: cat-factory)
      --runtime <r>       Kubernetes distribution: k3d | kind | k3s (default: k3d)
  -y, --yes               Non-interactive: pick the recommended path, never prompt
`
