import {
  CONTAINER_RUNTIMES,
  type ContainerRuntime,
  EXECUTION_MODES,
  type ExecutionMode,
  NATIVE_HARNESSES,
  type NativeHarness,
} from './templates.js'
import { VCS_PROVIDERS, type VcsProvider } from './vcs.js'

/** The Kubernetes distribution `cat-factory k3s` can provision/target. */
export const K3S_RUNTIMES = ['k3d', 'kind', 'k3s'] as const
export type K3sRuntime = (typeof K3S_RUNTIMES)[number]

/** Parsed, validated CLI options. Unset optionals are resolved later (defaults / prompts). */
export interface CliOptions {
  /**
   * The subcommand. `init` (the default when omitted) scaffolds a full project; `env` writes just
   * a ready-to-run local-mode `.env`; `k3s` is the guided local-cluster setup; `supervise` wraps a
   * dev command in the self-healing watchdog.
   */
  command: 'init' | 'env' | 'k3s' | 'supervise' | 'help' | 'version'
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
  /** How agent jobs execute: a Docker container pool (default) or native host agents. */
  executionMode?: ExecutionMode
  /** Native mode only: the subscription harnesses to run natively (`LOCAL_NATIVE_AGENTS`). */
  nativeHarnesses?: NativeHarness[]
  /** Native mode only: the executor-harness server entry path (`LOCAL_HARNESS_ENTRY`). */
  harnessEntry?: string
  /** `k3s` command: name for a provisioned local cluster. */
  clusterName?: string
  /** `k3s` command: the Kubernetes distribution to provision/target. */
  k3sRuntime?: K3sRuntime
  /**
   * `k3s` command: host port published into the cluster's ingress controller, so an
   * ingress-template environment URL resolves to something. Fixed at cluster-create time.
   */
  ingressPort?: number
  /**
   * `k3s` command: DESTROY the named local cluster and build it again from the current flags.
   *
   * A flag rather than a subcommand because everything a recreate needs (`--cluster-name`,
   * `--runtime`, `--ingress-port`) is already `k3s`'s own option surface, and the flow around it
   * (probe, RBAC, token, hand-off) is byte-for-byte the create path's: a subcommand would be the
   * same command with one step in front of it. It is also what makes destructive intent EXPLICIT
   * rather than inferred, since `--yes` alone can never select a recreate.
   */
  recreate?: boolean
  /** `k3s` command: base URL of the running SPA, opened (deep-linked) to wire the handler. */
  appUrl?: string
  /** `supervise` command: the command to run and keep alive — everything after `--`. */
  superviseCommand?: string[]
  /** `supervise` command: health endpoint path probed on `port` (default `/health`). */
  healthPath?: string
  /** `supervise` command: directory holding the `docker-compose.yml` (default: cwd). */
  composeDir?: string
  /** `supervise` command: compose service to keep up before each (re)start, e.g. `postgres`. */
  composeService?: string
  /** `supervise` command: local cluster to keep running (started if merely stopped). */
  k3sCluster?: string
  /** `supervise` command: seconds between health probes. */
  pollSeconds?: number
  /** `supervise` command: seconds after a (re)start during which failures don't count. */
  bootGraceSeconds?: number
  /** `supervise` command: consecutive failed probes required before a repair. */
  failures?: number
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

  const queue = [...argv]
  while (queue.length > 0) {
    const raw = queue.shift() as string

    // `--` ends option parsing: the rest is a command to hand to `supervise` verbatim, so its own
    // flags (`--watch`, `-y`, …) are never mistaken for ours.
    if (raw === '--') {
      opts.superviseCommand = [...queue]
      queue.length = 0
      break
    }

    const eq = raw.indexOf('=')
    const flag = raw.startsWith('--') && eq !== -1 ? raw.slice(0, eq) : raw
    const inline = raw.startsWith('--') && eq !== -1 ? raw.slice(eq + 1) : undefined

    const command = applyCommandToken(flag, opts, commandSet)
    if (command.handled) {
      commandSet = command.commandSet
      continue
    }

    const take = (f: string): string => takeOptionValue(f, inline, queue)
    if (!applyOptionFlag(flag, opts, take)) {
      throw new ArgError(`Unknown argument: ${raw}`)
    }
  }
  assertSuperviseOnlyFlagsAreScoped(opts)
  return opts
}

/**
 * The `supervise`-only flags are parsed by the one shared option table, so nothing structurally
 * stops `cat-factory init --failures 2` or a stray `--` from being accepted and then silently
 * ignored. Reject them here instead: an option that is read by no code path is a typo the user
 * wants to hear about, not a no-op. Listed as data so a new supervise flag joins the check by name
 * rather than being forgotten.
 */
const SUPERVISE_ONLY_FLAGS: ReadonlyArray<[keyof CliOptions, string]> = [
  ['superviseCommand', '--'],
  ['healthPath', '--health-path'],
  ['composeDir', '--compose-dir'],
  ['composeService', '--compose-service'],
  ['k3sCluster', '--k3s-cluster'],
  ['pollSeconds', '--poll'],
  ['bootGraceSeconds', '--boot-grace'],
  ['failures', '--failures'],
]

function assertSuperviseOnlyFlagsAreScoped(opts: CliOptions): void {
  if (opts.command === 'supervise' || opts.command === 'help' || opts.command === 'version') return
  for (const [key, flag] of SUPERVISE_ONLY_FLAGS) {
    if (opts[key] !== undefined) {
      throw new ArgError(
        `${flag} is only valid for \`cat-factory supervise\` (got: ${opts.command})`,
      )
    }
  }
}

/** Resolve a flag's value: the inline `--flag=value` form, else the next queued token. */
function takeOptionValue(flag: string, inline: string | undefined, rest: string[]): string {
  if (inline !== undefined) return inline
  const next = rest.shift()
  if (next === undefined) throw new ArgError(`Missing value for ${flag}`)
  return next
}

/**
 * Apply a leading subcommand token (`init`/`env`/`k3s`/`help`/`version` + their aliases).
 * Returns whether the token was a command and the resulting `commandSet` gate (only the first
 * positional `init`/`env`/`k3s` wins; `help`/`version` always latch).
 */
function applyCommandToken(
  flag: string,
  opts: CliOptions,
  commandSet: boolean,
): { handled: boolean; commandSet: boolean } {
  switch (flag) {
    case 'init':
    case 'env':
    case 'k3s':
    case 'supervise':
      if (!commandSet) {
        opts.command = flag
        commandSet = true
      }
      return { handled: true, commandSet }
    case 'help':
    case '--help':
    case '-h':
      opts.command = 'help'
      return { handled: true, commandSet: true }
    case 'version':
    case '--version':
    case '-v':
      opts.command = 'version'
      return { handled: true, commandSet: true }
    default:
      return { handled: false, commandSet }
  }
}

/**
 * The flags that name a local Kubernetes CLUSTER: which one, how it is built, and how the SPA is
 * reached to wire it. Split out of {@link applyOptionFlag} so the one table stays under the
 * complexity ratchet, and because they are the group that grows together (`--ingress-port` and
 * `--recreate` arrived as a pair with the ingress work). Returns `false` for anything not its own.
 */
function applyClusterFlag(flag: string, opts: CliOptions, take: (flag: string) => string): boolean {
  switch (flag) {
    case '--cluster-name':
      opts.clusterName = take(flag)
      break
    case '--runtime':
      opts.k3sRuntime = parseK3sRuntime(take(flag))
      break
    case '--ingress-port':
      opts.ingressPort = parsePort(take(flag), flag)
      break
    case '--recreate':
      opts.recreate = true
      break
    case '--app-url':
      opts.appUrl = parseAppUrl(take(flag))
      break
    case '--k3s-cluster':
      opts.k3sCluster = take(flag)
      break
    default:
      return false
  }
  return true
}

/**
 * Apply a single option flag, consuming its value from the queue (via `take`) where one is
 * required. Returns `false` for an unrecognised flag so the caller can raise the error.
 */
function applyOptionFlag(flag: string, opts: CliOptions, take: (flag: string) => string): boolean {
  if (applyClusterFlag(flag, opts, take)) return true
  switch (flag) {
    case '--dir':
    case '-d':
      opts.dir = take(flag)
      break
    case '--name':
      opts.projectName = take(flag)
      break
    case '--title':
      opts.appTitle = take(flag)
      break
    case '--provider':
      opts.provider = parseProvider(take(flag))
      break
    case '--token':
      opts.token = take(flag)
      break
    case '--db-url':
      opts.databaseUrl = take(flag)
      break
    case '--api-base':
      opts.apiBase = take(flag)
      break
    case '--port':
      opts.port = parsePort(take(flag))
      break
    case '--harness-image':
      opts.harnessImage = take(flag)
      break
    case '--container-runtime':
      opts.containerRuntime = parseContainerRuntime(take(flag))
      break
    case '--execution-mode':
      opts.executionMode = parseExecutionMode(take(flag))
      break
    case '--native-harnesses':
      opts.nativeHarnesses = parseNativeHarnesses(take(flag))
      break
    case '--harness-entry':
      opts.harnessEntry = take(flag)
      break
    case '--health-path':
      opts.healthPath = parseHealthPath(take(flag))
      break
    case '--compose-dir':
      opts.composeDir = take(flag)
      break
    case '--compose-service':
      opts.composeService = take(flag)
      break
    case '--poll':
      opts.pollSeconds = parseWholeSeconds(flag, take(flag), 1)
      break
    case '--boot-grace':
      // 0 is meaningful: a fast-booting toy command wants no grace window at all.
      opts.bootGraceSeconds = parseWholeSeconds(flag, take(flag), 0)
      break
    case '--failures':
      opts.failures = parseFailures(take(flag))
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
      return false
  }
  return true
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

function parseExecutionMode(value: string): ExecutionMode {
  const v = value.toLowerCase()
  if ((EXECUTION_MODES as readonly string[]).includes(v)) return v as ExecutionMode
  throw new ArgError(
    `Invalid --execution-mode "${value}" (expected: ${EXECUTION_MODES.join(' | ')})`,
  )
}

/**
 * Parse a comma-separated `--native-harnesses` list (e.g. `claude-code,codex`). `claude` is
 * accepted as an alias for `claude-code`, matching the backend's `LOCAL_NATIVE_AGENTS` alias.
 * Unlike the backend env parse (which also honours affirmative/off keywords like `both`/`off`
 * and fails safe to off), this explicit flag is strict: at least one recognised harness must be
 * named, and anything else is a hard error.
 */
function parseNativeHarnesses(value: string): NativeHarness[] {
  const out = new Set<NativeHarness>()
  for (const raw of value.split(',').map((s) => s.trim().toLowerCase())) {
    if (raw === 'claude-code' || raw === 'claude') out.add('claude-code')
    else if (raw === 'codex') out.add('codex')
    else if (raw !== '')
      throw new ArgError(
        `Invalid --native-harnesses "${value}" (expected: ${NATIVE_HARNESSES.join(' | ')})`,
      )
  }
  if (out.size === 0) {
    throw new ArgError(
      `Invalid --native-harnesses "${value}" (expected at least one of: ${NATIVE_HARNESSES.join(' | ')})`,
    )
  }
  return [...out]
}

function parseK3sRuntime(value: string): K3sRuntime {
  const v = value.toLowerCase()
  if ((K3S_RUNTIMES as readonly string[]).includes(v)) return v as K3sRuntime
  throw new ArgError(`Invalid --runtime "${value}" (expected: ${K3S_RUNTIMES.join(' | ')})`)
}

/** The probed health path must be rooted, so `--health-path health` can't silently probe nothing. */
function parseHealthPath(value: string): string {
  if (!value.startsWith('/')) {
    throw new ArgError(`Invalid --health-path "${value}" (expected a rooted path, e.g. /health)`)
  }
  return value
}

/**
 * Whole seconds only, and at least `min`. Fractions are refused rather than honoured: `--poll 0.001`
 * would otherwise build a 1ms poll loop that spins a core and — because the derived clock-jump
 * threshold is `poll * 3` — reads its own probe latency as a host suspend, so every failed probe
 * repairs at once and `--failures` stops meaning anything.
 */
function parseWholeSeconds(flag: string, value: string, min: number): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min) {
    throw new ArgError(`Invalid ${flag} "${value}" (expected a whole number of seconds >= ${min})`)
  }
  return n
}

function parseFailures(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw new ArgError(`Invalid --failures "${value}" (expected an integer >= 1)`)
  }
  return n
}

function parsePort(value: string, flag = '--port'): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ArgError(`Invalid ${flag} "${value}" (expected an integer 1-65535)`)
  }
  return n
}

/**
 * Validate the SPA base URL the k3s hand-off deep-links. Rejected here (before probing/
 * provisioning) rather than let a malformed value throw from `new URL(...)` at the very end of an
 * otherwise-successful run — a missing scheme (`localhost:3000` parses to protocol `localhost:`) is
 * an easy mistake, so require an absolute http(s) URL.
 */
function parseAppUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ArgError(
      `Invalid --app-url "${value}" (expected an absolute http(s) URL, e.g. http://localhost:3000)`,
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ArgError(`Invalid --app-url "${value}" (expected an http:// or https:// URL)`)
  }
  return value
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
  // No harnessImage default: an unset LOCAL_HARNESS_IMAGE lets the backend run the version it was
  // built against. `--harness-image` overrides it only when the user deliberately pins one.
  containerRuntime: 'docker' as ContainerRuntime,
  executionMode: 'pool' as ExecutionMode,
  // `k3s` command defaults.
  k3sClusterName: 'cat-factory',
  k3sRuntime: 'k3d' as K3sRuntime,
  // The local-mode SPA URL (matches the frontend served by `cat-factory init`) — the deep-link the
  // guided k3s hand-off opens to pre-fill the Local k3s connect form.
  appUrl: 'http://localhost:3000',
  // `supervise` probes the same `/health` every runtime mounts.
  healthPath: '/health',
} as const

export const HELP_TEXT = `cat-factory — bootstrap a local cat-factory deployment

Usage:
  cat-factory [init] [options]
  cat-factory env [options]
  cat-factory k3s [options]
  cat-factory supervise [options] -- <command...>

Commands:
  init   Scaffold a local-mode backend (local/) + frontend SPA (frontend/): generate the
         crypto secrets, mint a GitHub/GitLab PAT (opens your browser), write gitignored .env.
  env    Generate ONLY a ready-to-run local-mode .env in the current dir (or --dir): all three
         crypto secrets, a minted GitHub/GitLab PAT, and the execution mode — so local mode
         boots with no manual edits. Use it in an existing deployment dir (e.g. deploy/local).
  k3s    Guided local Kubernetes setup: probe the host for a usable cluster, then create (or
         reuse) one + a least-privilege ServiceAccount and print the values to wire the
         Local k3s environment handler. A k3s install needs sudo, so it is only ever printed.
  supervise  Run a dev command under a self-healing watchdog. 'node --watch' PARKS on crash
         (it restarts only on a file change), so a laptop sleep leaves the server dead with
         the port unbound and the SPA showing only "can't reach backend" — indefinitely. This
         probes the real signal (port listening AND /health 200), notices a resume, brings the
         database/cluster back, and restarts the command.

Options (init):
  -d, --dir <path>        Target directory (default: ./<name>)
      --name <name>       Project name slug (default: cat-factory)
      --title <title>     Frontend app title (default: Agent Architecture Board)
      --provider <p>      Source control: github | gitlab (default: github)
      --token <token>     PAT value (skips the browser/paste flow)
      --db-url <url>      Postgres DATABASE_URL
      --api-base <url>   Backend API base for the SPA (default: http://localhost:<port>)
      --port <n>          Backend HTTP port (default: 8787; also sets the SPA's api-base)
      --harness-image <ref>  Pin the executor-harness image (default: unset — the backend runs the version it was built against)
      --container-runtime <r>  Agent container runtime: docker | podman | orbstack | colima | apple
      --execution-mode <m>  How agents run: pool (Docker container pool) | native (host CLI)
      --native-harnesses <l>  Native mode: harnesses to run natively (claude-code,codex)
      --harness-entry <p>  Native mode: path to the executor-harness server entry
      --no-open           Don't open the browser (just print the token URL)
  -y, --yes               Non-interactive: use defaults/flags, never prompt
  -f, --force             Overwrite existing files
  -h, --help              Show this help
  -v, --version           Show the CLI version

Options (env):
  -d, --dir <path>        Directory to write .env into (default: current directory)
      --provider <p>      Source control: github | gitlab (default: github)
      --token <token>     PAT value (skips the browser/paste flow)
      --db-url <url>      Postgres DATABASE_URL
      --port <n>          Backend HTTP port (default: 8787)
      --harness-image <ref>  Pin the executor-harness image (default: unset — the backend runs the version it was built against)
      --container-runtime <r>  Agent container runtime: docker | podman | orbstack | colima | apple
      --execution-mode <m>  How agents run: pool (Docker container pool) | native (host CLI)
      --native-harnesses <l>  Native mode: harnesses to run natively (claude-code,codex)
      --harness-entry <p>  Native mode: path to the executor-harness server entry
      --no-open           Don't open the browser (just print the token URL)
  -y, --yes               Non-interactive: use defaults/flags, never prompt
  -f, --force             Overwrite an existing .env

Options (k3s):
      --cluster-name <n>  Name for a provisioned local cluster (default: cat-factory)
      --runtime <r>       Kubernetes distribution: k3d | kind | k3s (default: k3d)
      --ingress-port <n>  Host port published into the cluster's ingress controller (default: 80).
                          Fixed when the cluster is created: changing it needs --recreate.
      --recreate          DESTROY the named k3d/kind cluster and build it again from these flags.
                          Names what is on it first and asks before deleting. Never selected for
                          you: -y alone cannot pick this path.
      --app-url <url>     SPA base URL to deep-link for wiring (default: http://localhost:3000)
      --no-open           Don't open the browser at the pre-filled connect form (still prints it)
  -y, --yes               Non-interactive: pick the recommended path + skip confirms

  After provisioning, the values are printed and the SPA's Local k3s connect form is opened
  pre-filled (paste the token, then Test -> Save). A hands-free --register flag that POSTs the
  handler to the local API directly is a planned follow-up.

  Ingress-derived environment URLs need TWO things, and both are checked rather than assumed: an
  ingress controller in the cluster, and a host port published into it. A published host port
  cannot be added to a running k3d/kind cluster, which is what --recreate is for.

Options (supervise):
      --port <n>          Port the supervised server binds (default: 8787)
      --health-path <p>   Health endpoint probed on that port (default: /health)
  -d, --dir <path>        Working directory for the command (default: current directory)
      --compose-service <s>  docker compose service to keep up (e.g. postgres)
      --compose-dir <path>   Directory holding docker-compose.yml (default: --dir)
      --k3s-cluster <name>   Local k3d/kind cluster to keep running (started if stopped)
      --runtime <r>       Cluster distribution for --k3s-cluster: k3d | kind (default: k3d).
                          'k3s' is refused: a host service has no cluster to start from here.
      --poll <seconds>    Health probe interval, whole seconds (default: 10)
      --boot-grace <seconds>  Ignore failures for this long after a (re)start (default: 60)
      --failures <n>      Consecutive failed probes before repairing (default: 3)

  Everything after \`--\` is the supervised command, passed through untouched:
      cat-factory supervise --compose-service postgres -- pnpm dev

  A cluster that is merely STOPPED is started automatically. A cluster whose restart is blocked
  by a stale cgroup ("device or resource busy" — a state a suspend can leave behind) cannot be
  fixed from here: clearing it needs the container ENGINE restarted, which would kill every other
  container. That case is reported once, with the fix, instead of retried forever.

  The same rule applies to the supervised command itself: restarts that never reach a serving
  state are capped, and hitting the cap reports why and exits NON-ZERO rather than looping. A
  command that is simply broken cannot be repaired by killing it again.
`
