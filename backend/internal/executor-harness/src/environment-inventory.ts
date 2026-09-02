import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log, type Logger } from './logger.js'
import { harnessListenPort } from './harness-port.js'
import { probeDockerWorkload, type DockerWorkload } from './docker-capability.js'

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
//     is the half-truth the old instruction produced. It is answered by RUNNING `docker info`, and
//     a daemon this machine is CONFIGURED for but which has not answered yet is a fourth state
//     that resolves to `unknown`, never to the absence a refused connection looks like: the
//     image's daemon is started in the background and the job begins before it is ready.
//   - A daemon that ANSWERS is still not a daemon that WORKS, which is the same mistake one level
//     in. A rootless daemon nested in a sandbox serves while its snapshotter cannot mount any
//     image layer, so `docker info` succeeds and `docker build` / `docker run` / `docker pull`
//     all fail (issue #2120). Only a container that RAN settles that, so the reachable case is
//     split by a real workload (docker-capability.ts) into `usable`, `unusable`, and a daemon
//     that answered while the check itself could not be carried out.
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
 *
 * `found` is the outcome with no exit code, and it exists so that the Windows second look cannot
 * be mistaken for a run: the platform's own oracle located the binary and NOTHING WAS EXECUTED.
 * Collapsing it into `ran` with a synthesised `exitCode: 0` is what let `docker info` report a
 * reachable daemon on the strength of `where docker`, which is the CLI-for-daemon half-truth this
 * whole file exists to remove.
 */
export type ProbeResult =
  | { outcome: 'ran'; exitCode: number; output: string }
  | { outcome: 'found' }
  | { outcome: 'missing' }
  | { outcome: 'failed'; reason: string }

/** Run one probe. Injected so the suite drives every branch without needing the real binaries. */
export type ProbeRunner = (command: string, args: string[]) => Promise<ProbeResult>

/** What one probe learned. `unknown` is a THIRD answer, never folded into `absent`. */
export type ToolPresence =
  | { status: 'present'; version?: string }
  | { status: 'absent' }
  | { status: 'unknown'; reason: string }

/**
 * What this machine's Docker daemon is good for, which is FIVE answers and not three.
 *
 * `absent` and `unknown` mean for the daemon what they mean for any other tool. The three that
 * are particular to Docker split the case where a daemon ANSWERED, because answering is not the
 * question anyone is asking:
 *
 *   - `usable`:   a container was built and run on it here. `docker build` / `run` / `compose`
 *                   work, and this is the only state that may say so.
 *   - `unusable`: a container could NOT be run, with the daemon serving throughout. The state
 *                   issue #2120 is about; stated as a prohibition, with the cause.
 *   - `serving`:  it answered, and the workload check could not be carried out (no payload on
 *                   this machine, an unmapped architecture, a timeout). Neither of the other two,
 *                   and rendered as "try it if you need it".
 */
export type DockerCapability =
  | { status: 'usable'; server?: string }
  | { status: 'unusable'; server?: string; detail: string }
  | { status: 'serving'; server?: string; reason: string }
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
   * What the Docker daemon is good for: not the CLI's presence, and not merely whether the
   * daemon answered. The image's `entrypoint.sh` starts a rootless daemon BEST-EFFORT and execs
   * the server without waiting for it, so at job start this probe is the only thing that knows
   * how that went; "has not answered yet" is one of its answers (see {@link probeDockerDaemon})
   * and "answered, but cannot run a container" is another (see {@link DockerCapability}).
   */
  dockerDaemon: DockerCapability
  /**
   * The port the harness's own job server holds in this network namespace. Not probed: the
   * process reads its own {@link harnessListenPort}, which is the only honest answer when a
   * deployment overrides `PORT` and the only one available before anything is listening.
   */
  harnessPort: number
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

/** The daemon readiness probe: the one probe whose EXIT CODE, not its presence, is the answer. */
const DOCKER_INFO: { command: string; args: string[] } = {
  command: 'docker',
  args: ['info', '--format', '{{.ServerVersion}}'],
}

/**
 * Every probe here is either instant or wedged: a `--version` banner, and a `docker info` that
 * either connects or is REFUSED by a missing socket in milliseconds. So the ceiling is sized to
 * cut a wedged binary out of the job's critical path, not to wait for anything.
 *
 * It used to be ten seconds, on the stated grounds that `docker info` "can genuinely take a
 * moment" against a daemon still coming up. That was wrong in the way that matters: a daemon that
 * is not up yet has no socket to connect to, so docker exits non-zero AT ONCE and the ceiling is
 * never reached. Waiting for a starting daemon is a different problem and is solved where it
 * actually lives, in {@link probeDockerDaemon}'s retry.
 */
const PROBE_TIMEOUT_MS = 5_000

/**
 * How long a daemon that was EXPECTED here gets to answer before the block says it could not be
 * determined. One short retry, not a readiness wait: the honest verdict for a daemon still coming
 * up is `unknown`, which the rendered line turns into "try it if you need it", so there is nothing
 * to buy by blocking the agent's first turn any longer than this.
 */
const DAEMON_RETRY_DELAY_MS = 1_500

/**
 * The real runner: spawn the tool, bounded, and report what the spawn did.
 *
 * The Windows second look is for the NATIVE transport on a developer's own machine, not for the
 * image. `execFile` without a shell resolves `.exe` and not `.cmd`, and Node refuses to spawn a
 * `.cmd` at all without one, so a perfectly installed `npm` or `pnpm` comes back `ENOENT` there and
 * would be stated to the agent as NOT INSTALLED. `where` is the platform's own presence oracle and
 * answers that without running the shim, at the cost of the version, which is the honest trade: the
 * rendered line then names the tool with no number rather than claiming one or denying the tool.
 *
 * It answers PRESENCE and nothing else, which is why it returns `found` and why it ignores `args`
 * without pretending otherwise: `where <command>` locates a binary, so it can say nothing about
 * what that binary would have printed or exited with. The version is not the only thing lost. A
 * probe whose ANSWER is its exit code (`docker info`) gets no answer at all from this branch, and
 * {@link daemonPresence} is where that is turned into an unknown rather than a reachable daemon.
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
    return readOracle(await attempt('where', [command]))
  }
}

/**
 * What the `where` oracle's own result says about the TOOL. Pure, and separate from the spawn, so
 * every branch is asserted on any platform: reproducing the failing one for real needs a process
 * whose PATH cannot reach `where`, and mutating the live `PATH` to get one leaks into whatever test
 * runs next (on Windows `PATH` and `Path` are one variable, so restoring them is not symmetric).
 *
 * The distinction the branches exist for: `where` exiting non-zero IS the tool's absence, but
 * `where` not answering at all says nothing about the tool, so that becomes a FAILED probe. Passing
 * the oracle's result straight back reported the ORACLE's own `missing` as the tool's, which put a
 * fully installed npm on the "Not installed" line on any host where `where` cannot be spawned.
 *
 * A located tool is `found`, never a synthesised `ran` with `exitCode: 0`: the oracle located a
 * binary and executed nothing, so it cannot answer for a probe whose answer IS its exit code.
 */
export function readOracle(located: ProbeResult): ProbeResult {
  if (located.outcome === 'ran') {
    return located.exitCode === 0 ? { outcome: 'found' } : { outcome: 'missing' }
  }
  if (located.outcome === 'found') return located
  return {
    outcome: 'failed',
    reason:
      located.outcome === 'failed'
        ? located.reason
        : 'the tool could not be spawned, and `where` could not be run to locate it',
  }
}

/**
 * Read a rejected `execFile` back into a {@link ProbeResult}.
 *
 * `ENOENT` is the ONLY absence: the binary is not on PATH. A numeric `code` means the binary RAN
 * and exited non-zero, which is a different fact and belongs to whoever asked. Everything else
 * (a timeout, where the child is killed and there is no exit code; `EACCES`; an aborted job) is a
 * failure OF THE PROBE, which is what keeps it out of the absent list.
 *
 * Every reason is WRITTEN HERE, in words, and the raw `code` is never one of them. The reason is
 * rendered verbatim into the agent's system prompt, so passing `String(e.code)` through published
 * `ABORT_ERR` (a cancelled job, on all thirteen entries at once), `EACCES` and
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` to a model as prose. A code nobody has mapped yet says only
 * that the probe did not run, which is the whole of what the block needs from it.
 */
function spawnFailure(err: unknown): ProbeResult {
  const e = err as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string }
  if (e.code === 'ENOENT') return { outcome: 'missing' }
  if (typeof e.code === 'number') {
    return { outcome: 'ran', exitCode: e.code, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}` }
  }
  // Abort before the timeout check: `execFile`'s `AbortError` carries no `killed`, so an aborted
  // job would otherwise fall through to the catch-all and read as a machine that answered nothing.
  if (e.code === 'ABORT_ERR' || (e as Error).name === 'AbortError') {
    return { outcome: 'failed', reason: 'the job was cancelled before the probe finished' }
  }
  if (e.killed) return { outcome: 'failed', reason: 'the probe timed out' }
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    return { outcome: 'failed', reason: 'the probe was not permitted to run here' }
  }
  return { outcome: 'failed', reason: 'the probe could not be run' }
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
  if (result.outcome === 'found') return { status: 'present' }
  const version = firstVersion(result.output)
  return version ? { status: 'present', version } : { status: 'present' }
}

/**
 * The daemon's presence, which reads the SAME result differently in exactly TWO places, and
 * delegates the rest: duplicating the other three branches to add these two is how a change to
 * how a version is read, or how a failure reason is carried, gets made in one classifier only.
 *
 *   - A non-zero exit is "cannot connect to the Docker daemon", so it is an absence rather than the
 *     proof-of-install a non-zero exit is everywhere else.
 *   - `found` means the Windows oracle located the CLI and ran NOTHING, so the daemon was never
 *     asked. That is an unknown. Reading it as `toolPresence` would is what made `where docker`
 *     enough to tell an agent `docker build` works here.
 */
export function daemonPresence(result: ProbeResult): ToolPresence {
  if (result.outcome === 'found') {
    return {
      status: 'unknown',
      reason: 'only the docker CLI was located; the daemon was not asked',
    }
  }
  if (result.outcome === 'ran' && result.exitCode !== 0) return { status: 'absent' }
  return toolPresence(result)
}

/** What one probe pass may be told, so the suite drives the daemon's retry without waiting on it. */
export interface ProbeEnvironmentOptions {
  /** Injected so tests exercise the retry without paying {@link DAEMON_RETRY_DELAY_MS}. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Whether a daemon is CONFIGURED to serve this machine, defaulting to {@link daemonIsConfigured}.
   * Stated as the fact rather than as the `DOCKER_HOST` string it is read from, so a test can drive
   * both sides of the branch without an ambient environment variable deciding the outcome for it.
   */
  daemonExpected?: boolean
  /**
   * The port the harness holds, defaulting to what this process is actually listening on. Injected
   * only so the suite can assert the rendered line without an ambient `PORT` deciding its text.
   */
  harnessPort?: number
  /**
   * Whether the daemon can actually RUN a container, defaulting to the process-wide probe
   * (docker-capability.ts). Asked only once a daemon has answered, since there is nothing to run
   * a workload on otherwise, and memoised per container so a warm pool pays for it once.
   */
  workload?: (signal?: AbortSignal) => Promise<DockerWorkload>
  /**
   * The job's signal, forwarded to the probes that spawn something. The workload check starts a
   * CONTAINER, so a cancelled job must stop paying for it rather than hold the daemon for the
   * rest of its budget.
   */
  signal?: AbortSignal
}

/**
 * Whether anything is supposed to serve a Docker daemon here, which `entrypoint.sh` makes knowable:
 * it EXPORTS `DOCKER_HOST` both when a pool hands us an external daemon and when it starts the
 * rootless one, and leaves it unset in the one branch where no daemon is coming. Reading the
 * machine's own configuration, not per-job state, so `process.env` is the right source here.
 */
function daemonIsConfigured(): boolean {
  return (process.env.DOCKER_HOST ?? '').trim() !== ''
}

/**
 * Probe the machine. EVERYTHING runs concurrently, the daemon included.
 *
 * The daemon probe used to be sequenced after the tool pass, so that a missing CLI could
 * short-circuit it. That bought a cleaner `absent` and charged the whole job for it: two ceilings
 * back to back on the critical path, ahead of the clone, on every dispatch. It is unnecessary,
 * because `docker info` answers the CLI question too: with no CLI on PATH the spawn comes back
 * `missing`, which {@link daemonPresence} already reads as the same absence the short-circuit
 * produced. Asking directly also removes a second defect the sequencing needed: reading the CLI's
 * presence back out of `tools` defaulted a MISSING list entry to `absent`, so trimming the curated
 * list would have had the block assert "NO Docker daemon is reachable" with nothing ever asked.
 */
export async function probeEnvironment(
  run: ProbeRunner,
  opts: ProbeEnvironmentOptions = {},
): Promise<EnvironmentInventory> {
  const [tools, dockerDaemon] = await Promise.all([
    Promise.all(
      PROBES.map(async (probe) => ({
        name: probe.name,
        showVersion: probe.showVersion,
        presence: toolPresence(await run(probe.command, probe.args)),
      })),
    ),
    probeDockerCapability(run, opts),
  ])
  return { tools, dockerDaemon, harnessPort: opts.harnessPort ?? harnessListenPort() }
}

/**
 * The daemon's full answer: whether one is reachable, and then whether it can run a container.
 *
 * The two steps are kept apart because they fail for unrelated reasons and only the FIRST has a
 * cheap answer. A daemon nobody can reach has no workload to run, so the check that costs a
 * container start is asked only where there is something to ask it of; a daemon that answered
 * carries its server version into every one of the three states that follow it, because the
 * agent reading the line is entitled to know which daemon the verdict is about.
 */
async function probeDockerCapability(
  run: ProbeRunner,
  opts: ProbeEnvironmentOptions,
): Promise<DockerCapability> {
  const daemon = await probeDockerDaemon(run, opts)
  if (daemon.status === 'absent') return { status: 'absent' }
  if (daemon.status === 'unknown') return { status: 'unknown', reason: daemon.reason }
  const server = daemon.version ? { server: daemon.version } : {}
  const workload = await (opts.workload ?? probeDockerWorkload)(opts.signal)
  if (workload.status === 'usable') return { status: 'usable', ...server }
  if (workload.status === 'unusable')
    return { status: 'unusable', ...server, detail: workload.detail }
  return { status: 'serving', ...server, reason: workload.reason }
}

/**
 * Ask the daemon itself, and do not mistake a daemon that is STARTING for one that is not there.
 *
 * `entrypoint.sh` launches `dockerd-rootless.sh` detached and `exec`s the server without waiting,
 * so `/health` answers (and the backend POSTs `/run`) seconds before the rootless daemon has
 * finished its userns and fuse-overlayfs setup. Until then there is no socket, so `docker info`
 * is refused AT ONCE. Read as a plain absence that produced the block's most consequential line,
 * "NO Docker daemon is reachable ... will fail here whatever the CLI reports", on a machine whose
 * daemon was up moments later, which authoritatively told a tester step not to try.
 *
 * Whether a daemon is CONFIGURED here is what separates the two (see {@link daemonIsConfigured}):
 *
 *   - refused with no `DOCKER_HOST` ⇒ ABSENT. Nothing was coming. This is also the developer's
 *     laptop with Docker Desktop shut down, where absent is exactly right.
 *   - refused with `DOCKER_HOST` set ⇒ one short retry, then UNKNOWN. A daemon was expected and
 *     has not answered yet, which is neither of the other two answers, and the rendered line turns
 *     it into "try it if you need it" rather than into a prohibition.
 */
async function probeDockerDaemon(
  run: ProbeRunner,
  opts: ProbeEnvironmentOptions,
): Promise<ToolPresence> {
  const expected = opts.daemonExpected ?? daemonIsConfigured()
  const ask = async (): Promise<ToolPresence> =>
    daemonPresence(await run(DOCKER_INFO.command, DOCKER_INFO.args))
  const first = await ask()
  if (first.status !== 'absent' || !expected) return first
  await (opts.sleep ?? defaultSleep)(DAEMON_RETRY_DELAY_MS)
  const second = await ask()
  if (second.status !== 'absent') return second
  return {
    status: 'unknown',
    reason:
      'a daemon is configured for this machine but had not answered when the job started; it may ' +
      'still be coming up',
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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
      `Not installed: ${absent.map((t) => t.name).join(', ')}. You are unprivileged here, so a ` +
        'SYSTEM install of one of these will fail, and a tool the platform did not provide is not ' +
        "a defect in the work. Where one of them is the project's own package manager, reaching " +
        'it for that project alone (`npx <manager>`, a repo-local install) is fine and is the one ' +
        'thing worth trying.',
    )
  }
  if (unknown.length > 0) {
    lines.push(
      'Could not be determined, because the PROBE itself failed. Treat each as neither present ' +
        `nor absent: ${unknown.join(', ')}.`,
    )
  }
  lines.push(dockerDaemonLine(inventory.dockerDaemon))
  lines.push(harnessPortLine(inventory.harnessPort))
  // Stated as a FACT and not as an errand. This block is appended to the system prompt after the
  // effort-report directive, whose closing sentences are the prompt's ordering rule (write the
  // sentinel, then reply, and no tool call after the reply). "Check for that one yourself before
  // relying on it" sat after that rule and invited exactly the trailing tool call it forbids, which
  // is the displacement that once cost an architect run its design. The agent needs to know the
  // list is bounded; when to go looking is the sandbox directive's business, and it is not last.
  lines.push(
    'Nothing else was probed. A tool named on none of these lines is unknown to the platform ' +
      'rather than missing.',
  )
  return lines.join('\n')
}

/**
 * The one port line: what the platform already holds, and why a request to it is not evidence.
 *
 * Stated because the harness shares this network namespace with everything the agent starts, so a
 * port it holds is a port the agent cannot have, and because the failure that follows is not a
 * refusal but a WRONG ANSWER. The harness answers `/health` with a 200 whose body begins
 * `{"status":"ok"}`, so a tester that probes the port its service was supposed to be on grades the
 * platform green and says nothing. A run hit exactly that: the service under test was specified to
 * listen on 8080, the harness held it, the app died with `EADDRINUSE`, and only a second route with
 * a distinctive body gave the trap away.
 *
 * The default port has since moved out of the range anything reaches for by habit, which is the
 * real fix. This line is what remains true whatever a deployment sets `PORT` to, and it names the
 * NUMBER rather than the danger so an agent can pick another port up front instead of diagnosing a
 * bind failure it did not cause.
 */
function harnessPortLine(port: number): string {
  return (
    `Port ${port} is already bound here, by the platform's harness process itself. Do not start ` +
    'anything on it, and do not read what it serves as your own service: it answers requests, ' +
    `including a 200 on \`/health\` with a JSON body that begins \`{"status":"ok"}\`, so a health ` +
    'check aimed at it passes without your service ever having run. Bind anything you start ' +
    'somewhere else.'
  )
}

/**
 * The Docker line, which says something different in each of the five cases, and is TOTAL over
 * them: adding a state without deciding what an agent should do about it stops the build.
 *
 * Only `usable` may claim the commands work, and it may only be reached by having RUN one. The
 * line that used to stand here made that claim off `docker info` alone, which is how every agent
 * in a run was told, as fact, that a daemon which could not mount a single image layer would
 * build and run one.
 */
function dockerDaemonLine(daemon: DockerCapability): string {
  const server = 'server' in daemon && daemon.server ? ` (server ${daemon.server})` : ''
  switch (daemon.status) {
    case 'usable':
      return (
        `A Docker daemon is reachable${server} and the platform ran a container on it: ` +
        '`docker build`, `docker run` and `docker compose up` work here.'
      )
    case 'unusable':
      return (
        `A Docker daemon is reachable${server} but it CANNOT run a container: the platform ` +
        `built a one-layer image and tried to run it here, and that failed (${daemon.detail}). ` +
        '`docker build`, `docker run`, `docker pull` of a multi-layer image and ' +
        '`docker compose up` all fail for the same reason, so there is nothing to retry and no ' +
        'flag that works around it. Produce the Dockerfile or compose file you were asked for, ' +
        'say in one line that it could not be built or run here, and move on.'
      )
    case 'serving':
      return (
        `A Docker daemon is reachable${server}, but whether it can actually build or run an ` +
        `image was NOT established (${daemon.reason}). Reaching the daemon is not the same fact: ` +
        'a sandboxed one answers while being unable to mount any image layer. Try it if you need ' +
        'it, and do not read a failure as a defect in the work.'
      )
    case 'unknown':
      return (
        'Whether a Docker daemon is reachable could not be determined ' +
        `(${daemon.reason}): try it if you need it, and do not read a failure as a defect in the work.`
      )
    case 'absent':
      return (
        'NO Docker daemon is reachable: `docker build`, `docker run` and `docker compose up` ' +
        'will fail here whatever the CLI reports. Produce the Dockerfile or compose file you ' +
        'were asked for, say in one line that you could not build it here, and move on.'
      )
    default:
      return unnamedCapability(daemon)
  }
}

function unnamedCapability(daemon: never): string {
  return `Whether a Docker daemon is reachable could not be determined (the platform reported an unrecognised verdict ${JSON.stringify(daemon)}): try it if you need it.`
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
  opts: { log?: Logger; run?: ProbeRunner } & ProbeEnvironmentOptions = {},
): Promise<string> {
  const logger = opts.log ?? log
  // Everything that is not this function's OWN is forwarded by construction, rather than key by
  // key. The list of copied keys silently dropped `workload`, whose whole point is that a suite
  // can inject one: a test driving THIS entry point (the only one `handleAgent` uses) got the
  // real probe instead, which starts a container on whatever machine the suite runs on.
  const { log: _log, run, ...probeOptions } = opts
  try {
    const inventory = await probeEnvironment(run ?? spawnProbeRunner(opts.signal), probeOptions)
    logger.info('agent: probed the environment', {
      installed: inventory.tools
        .filter((t) => t.presence.status === 'present')
        .map((t) => t.name)
        .join(','),
      dockerDaemon: inventory.dockerDaemon.status,
      // The unknowns, by NAME: the block tells the agent a probe failed, and this is the only place
      // an operator can see WHICH, since the reason the agent reads is deliberately wordy prose.
      unknown: inventory.tools
        .filter((t) => t.presence.status === 'unknown')
        .map((t) => t.name)
        .join(','),
    })
    return `${systemPrompt}\n\n${renderEnvironmentInventory(inventory)}`
  } catch (err) {
    logger.warn('agent: the environment probe pass failed; dispatching without an inventory', {
      error: err instanceof Error ? err.message : String(err),
    })
    return systemPrompt
  }
}
