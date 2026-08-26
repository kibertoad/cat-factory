import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log, type Logger } from './logger.js'

// ---------------------------------------------------------------------------
// What this machine actually has, probed ONCE per job and stated to the agent.
//
// The platform used to tell every agent to discover its own environment ("probe for a tool before
// relying on it"), and every agent did, repeatedly, and often twice within one run: an architect
// ran `for c in docker kubectl helm kustomize; do command -v $c; done`, then `docker info`, and
// the coder it handed off to rediscovered both answers thirty calls later. Four calls out of a
// forty-call budget, spent on facts the harness holds before the agent's first turn.
//
// This is the layer that CAN hold them, and the only one. The backend composes its prompt before a
// transport is even chosen, and the same job body serves the harness image, a deployment's own
// image variant and (under `LOCAL_NATIVE_AGENTS`) the developer's own machine, where the
// toolchain is theirs. So the backend states the POLICY (no cluster credentials; an artifact this
// environment cannot execute is still a correct artifact) and names no tooling at all, while this
// file states the FACTS, from a probe of the machine the agent is about to run on.
//
// Three rules the block is built around:
//
//   - ABSENT and UNKNOWN must not render the same. Only a spawn that came back `ENOENT` is an
//     absence; a probe that failed says so and is reported as neither present nor absent.
//   - A tool NOT ON THE LIST is unknown too, which the block's last line says. The list is curated
//     (what agents were observed rediscovering), so silence about `terraform` has to read as
//     "nobody looked", never as "it isn't there".
//   - The Docker DAEMON is a separate fact from the docker CLI, and it is the one that decides
//     anything: `command -v docker` succeeds in this image and `docker build` still fails, which
//     is the half-truth the old instruction produced. It is answered by RUNNING `docker info`.
//
// Deliberately NOT here: the agent's own tools (web search, file tools, MCP servers). Those are
// the CLI's, they differ per harness, and each is already stated where it is true. Claiming one
// here would be the platform asserting a capability the dispatch may not have delivered, which is
// the defect this whole change exists to remove.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile)

/**
 * What running one probe did, kept as RAW as the spawn: whether the binary ran, and with what.
 * Classification into presence lives in pure code below, because the two callers classify the
 * same result differently: a non-zero exit proves an ordinary tool is installed and proves the
 * Docker daemon is not reachable.
 */
export type ProbeResult =
  | { outcome: 'ran'; exitCode: number; output: string }
  | { outcome: 'missing' }
  | { outcome: 'failed'; reason: string }

/** Run one probe. Injected so the suite drives every branch without needing the real binaries. */
export type ProbeRunner = (command: string, args: string[]) => Promise<ProbeResult>

/** What one probe learned. `unknown` is a THIRD answer, never folded into `absent`. */
export type ToolPresence =
  | { status: 'present'; version?: string }
  | { status: 'absent' }
  | { status: 'unknown'; reason: string }

/** One probed entry: the name the agent would type, and what came back. */
export interface ProbedTool {
  name: string
  presence: ToolPresence
  /** Whether the rendered line carries the version. Off where a yes/no is the whole answer. */
  showVersion: boolean
}

/** Everything one job's probe pass learned about the machine it is about to run on. */
export interface EnvironmentInventory {
  tools: ProbedTool[]
  /**
   * Whether a Docker daemon actually answered: the readiness fact, not the CLI's presence. The
   * image's `entrypoint.sh` starts a rootless daemon BEST-EFFORT and execs the server without
   * waiting for it, so at job start this probe is the only thing that knows how that went.
   */
  dockerDaemon: ToolPresence
}

/**
 * The curated probe list: the toolchain an agent assumes, plus the tools runs were observed
 * burning calls to discover. Kept SHORT on purpose. Every entry is a spawn and a few more words
 * in every system prompt, and the block's closing line keeps an unlisted tool honestly unknown
 * rather than implicitly absent.
 *
 * `showVersion` is on where the number changes what the agent does (comparing against a target's
 * declared engines, a language's syntax level) and off where presence is the whole question.
 */
const PROBES: ReadonlyArray<{
  name: string
  command: string
  args: string[]
  showVersion: boolean
}> = [
  { name: 'node', command: 'node', args: ['--version'], showVersion: true },
  { name: 'npm', command: 'npm', args: ['--version'], showVersion: true },
  { name: 'pnpm', command: 'pnpm', args: ['--version'], showVersion: true },
  { name: 'git', command: 'git', args: ['--version'], showVersion: true },
  { name: 'python3', command: 'python3', args: ['--version'], showVersion: true },
  { name: 'docker', command: 'docker', args: ['--version'], showVersion: false },
  { name: 'jq', command: 'jq', args: ['--version'], showVersion: false },
  { name: 'rg', command: 'rg', args: ['--version'], showVersion: false },
  { name: 'curl', command: 'curl', args: ['--version'], showVersion: false },
  { name: 'make', command: 'make', args: ['--version'], showVersion: false },
  { name: 'kubectl', command: 'kubectl', args: ['version', '--client'], showVersion: false },
  { name: 'helm', command: 'helm', args: ['version'], showVersion: false },
  { name: 'kustomize', command: 'kustomize', args: ['version'], showVersion: false },
]

/** The daemon readiness probe, run only once its CLI has answered. */
const DOCKER_INFO: { command: string; args: string[] } = {
  command: 'docker',
  args: ['info', '--format', '{{.ServerVersion}}'],
}

/**
 * A `--version` call is either instant or wedged, so ten seconds is far past the first and well
 * inside the inactivity watchdog. `docker info` against a daemon still coming up is the one that
 * can genuinely take a moment, and that is what the ceiling is sized for.
 */
const PROBE_TIMEOUT_MS = 10_000

/**
 * The real runner: spawn the tool, bounded, and report what the spawn did.
 *
 * The Windows second look is for the NATIVE transport on a developer's own machine, not for the
 * image. `execFile` without a shell resolves `.exe` and not `.cmd`, and Node refuses to spawn a
 * `.cmd` at all without one, so a perfectly installed `npm` or `pnpm` comes back `ENOENT` there and
 * would be stated to the agent as NOT INSTALLED. `where` is the platform's own presence oracle and
 * answers that without running the shim, at the cost of the version, which is the honest trade: the
 * rendered line then names the tool with no number rather than claiming one or denying the tool.
 */
export function spawnProbeRunner(signal?: AbortSignal): ProbeRunner {
  const attempt = async (command: string, args: string[]): Promise<ProbeResult> => {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      })
      return { outcome: 'ran', exitCode: 0, output: `${stdout}\n${stderr}` }
    } catch (err) {
      return spawnFailure(err)
    }
  }
  return async (command, args) => {
    const first = await attempt(command, args)
    if (first.outcome !== 'missing' || process.platform !== 'win32') return first
    const found = await attempt('where', [command])
    // `where` exiting non-zero IS the absence; `where` itself failing to run is an unknown, and
    // passing that through unchanged is what keeps the two apart.
    if (found.outcome !== 'ran') return found
    return found.exitCode === 0
      ? { outcome: 'ran', exitCode: 0, output: '' }
      : { outcome: 'missing' }
  }
}

/**
 * Read a rejected `execFile` back into a {@link ProbeResult}.
 *
 * `ENOENT` is the ONLY absence: the binary is not on PATH. A numeric `code` means the binary RAN
 * and exited non-zero, which is a different fact and belongs to whoever asked. Everything else
 * (a timeout, where the child is killed and there is no exit code; `EACCES`; an aborted job) is a
 * failure OF THE PROBE, which is what keeps it out of the absent list.
 */
function spawnFailure(err: unknown): ProbeResult {
  const e = err as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string }
  if (e.code === 'ENOENT') return { outcome: 'missing' }
  if (typeof e.code === 'number') {
    return { outcome: 'ran', exitCode: e.code, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}` }
  }
  if (e.killed) return { outcome: 'failed', reason: 'the probe timed out' }
  return { outcome: 'failed', reason: e.code ? String(e.code) : 'the probe could not be run' }
}

/**
 * The first version-shaped token in a `--version` banner, capped so a chatty tool can't run away.
 *
 * Deliberately no leading `\b`: the token is routinely glued to a letter (`v26.7.0`, `helm
 * v3.16.2`), and a word boundary between `v` and `2` does not exist, so the anchored form skipped
 * the major and reported `26.7.0` as `7.0`.
 */
function firstVersion(output: string): string | undefined {
  const match = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(output)
  return match ? match[0].slice(0, 24) : undefined
}

/**
 * An ordinary tool's presence: it ran (whatever it exited with) ⇒ installed, `ENOENT` ⇒ not
 * installed, anything else ⇒ the probe failed and we do not know. `helm version` on a host with
 * no cluster config exits non-zero and still proves helm is installed.
 */
export function toolPresence(result: ProbeResult): ToolPresence {
  if (result.outcome === 'missing') return { status: 'absent' }
  if (result.outcome === 'failed') return { status: 'unknown', reason: result.reason }
  const version = firstVersion(result.output)
  return version ? { status: 'present', version } : { status: 'present' }
}

/**
 * The daemon's presence, which reads the SAME result differently: `docker info` exiting non-zero
 * is "cannot connect to the Docker daemon", so it is an absence rather than the proof-of-install a
 * non-zero exit is everywhere else.
 */
export function daemonPresence(result: ProbeResult): ToolPresence {
  if (result.outcome === 'missing') return { status: 'absent' }
  if (result.outcome === 'failed') return { status: 'unknown', reason: result.reason }
  if (result.exitCode !== 0) return { status: 'absent' }
  const version = firstVersion(result.output)
  return version ? { status: 'present', version } : { status: 'present' }
}

/**
 * Probe the machine. The tools run concurrently (independent `--version` calls), and the Docker
 * daemon is probed after its CLI: with no CLI there is nothing to ask, and "the CLI is missing so
 * the daemon could not be checked" would be an unknown where an absence is the honest answer.
 */
export async function probeEnvironment(run: ProbeRunner): Promise<EnvironmentInventory> {
  const tools = await Promise.all(
    PROBES.map(async (probe) => ({
      name: probe.name,
      showVersion: probe.showVersion,
      presence: toolPresence(await run(probe.command, probe.args)),
    })),
  )
  const cli = tools.find((t) => t.name === 'docker')?.presence ?? { status: 'absent' as const }
  return { tools, dockerDaemon: await probeDockerDaemon(cli, run) }
}

/** Ask the daemon itself, but only once its CLI has answered for it. */
async function probeDockerDaemon(cli: ToolPresence, run: ProbeRunner): Promise<ToolPresence> {
  if (cli.status === 'absent') return { status: 'absent' }
  if (cli.status === 'unknown') {
    return { status: 'unknown', reason: 'the docker CLI probe failed, so nothing was asked of it' }
  }
  return daemonPresence(await run(DOCKER_INFO.command, DOCKER_INFO.args))
}

/** Render one tool for the `Installed:` line: `node 26.7.0`, or just `jq`. */
function installedLabel(tool: ProbedTool): string {
  const version = tool.presence.status === 'present' ? tool.presence.version : undefined
  return tool.showVersion && version ? `${tool.name} ${version}` : tool.name
}

/**
 * The block appended to the agent's system prompt. Pure, so what the agent reads is asserted
 * against a probe result rather than against whichever machine the suite happens to run on.
 *
 * Each line is a different KIND of claim, and they are kept apart because collapsing them is the
 * failure this replaces: what is here, what is not, what could not be determined, what the Docker
 * daemon actually said, and, last because it governs everything the other lines omit, that the
 * list is bounded.
 */
export function renderEnvironmentInventory(inventory: EnvironmentInventory): string {
  const installed = inventory.tools.filter((t) => t.presence.status === 'present')
  const absent = inventory.tools.filter((t) => t.presence.status === 'absent')
  // Flattened while the presence is still narrowed: the REASON is what makes an entry an unknown
  // rather than an absence, so it has to reach the rendered line, and picking it back out of a
  // `ProbedTool` later needs a re-narrowing branch nothing can ever take.
  const unknown = inventory.tools.flatMap((t) =>
    t.presence.status === 'unknown' ? [`${t.name} (${t.presence.reason})`] : [],
  )
  const lines = [
    'ENVIRONMENT INVENTORY: the platform probed this machine when the job started. These are ' +
      'facts about where you are running; do not spend turns re-checking them.',
  ]
  if (installed.length > 0) {
    lines.push(`Installed: ${installed.map(installedLabel).join(', ')}.`)
  }
  if (absent.length > 0) {
    lines.push(
      `Not installed: ${absent.map((t) => t.name).join(', ')}. Do not try to install one of ` +
        'these; a tool the platform did not provide is not a defect in the work.',
    )
  }
  if (unknown.length > 0) {
    lines.push(
      'Could not be determined, because the PROBE itself failed. Treat each as neither present ' +
        `nor absent: ${unknown.join(', ')}.`,
    )
  }
  lines.push(dockerDaemonLine(inventory.dockerDaemon))
  lines.push(
    'Nothing else was probed. A tool named on none of these lines is unknown to the platform ' +
      'rather than missing, so check for that one yourself before relying on it.',
  )
  return lines.join('\n')
}

/** The Docker line, which says something different in each of the three cases. */
function dockerDaemonLine(daemon: ToolPresence): string {
  if (daemon.status === 'present') {
    const server = daemon.version ? ` (server ${daemon.version})` : ''
    return (
      `A Docker daemon is reachable${server}: \`docker build\`, \`docker run\` and ` +
      '`docker compose up` work here.'
    )
  }
  if (daemon.status === 'unknown') {
    return (
      'Whether a Docker daemon is reachable could not be determined ' +
      `(${daemon.reason}): try it if you need it, and do not read a failure as a defect in the work.`
    )
  }
  return (
    'NO Docker daemon is reachable: `docker build`, `docker run` and `docker compose up` will ' +
    'fail here whatever the CLI reports. Produce the Dockerfile or compose file you were asked ' +
    'for, say in one line that you could not build it here, and move on.'
  )
}

/**
 * Probe the machine and fold the inventory onto `systemPrompt`. THE composition point: the harness
 * calls this once per job, in `handleAgent`, before any mode branches, so every mode and every CLI
 * (claude-code, codex, Pi) inherits it from the job's own system prompt instead of each folding a
 * copy, which is how one of them would silently end up without it, and another with it twice.
 *
 * It rides the SYSTEM prompt rather than the task prompt so it survives the claude runner's
 * argv-size branch (`carryClaudeSystemPrompt` folds an oversized system prompt into stdin whole),
 * Codex's unconditional fold and Pi's `AGENTS.md` write, none of which can drop part of it.
 *
 * Never throws: an inventory is context, and a job whose probe pass fell over is still a job worth
 * running. A probe that fails is already reported as unknown by construction, so this catch is for
 * the pass itself, and it says so in a log line rather than silently shortening the prompt.
 */
export async function appendEnvironmentInventory(
  systemPrompt: string,
  opts: { signal?: AbortSignal; log?: Logger; run?: ProbeRunner } = {},
): Promise<string> {
  const logger = opts.log ?? log
  try {
    const inventory = await probeEnvironment(opts.run ?? spawnProbeRunner(opts.signal))
    logger.info('agent: probed the environment', {
      installed: inventory.tools
        .filter((t) => t.presence.status === 'present')
        .map((t) => t.name)
        .join(','),
      dockerDaemon: inventory.dockerDaemon.status,
    })
    return `${systemPrompt}\n\n${renderEnvironmentInventory(inventory)}`
  } catch (err) {
    logger.warn('agent: the environment probe pass failed; dispatching without an inventory', {
      error: err instanceof Error ? err.message : String(err),
    })
    return systemPrompt
  }
}
