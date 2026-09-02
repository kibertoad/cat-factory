import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendEnvironmentInventory,
  daemonPresence,
  probeEnvironment,
  readOracle,
  renderEnvironmentInventory,
  spawnProbeRunner,
  toolPresence,
  type EnvironmentInventory,
  type ProbeResult,
  type ProbeRunner,
} from '../src/environment-inventory.js'
import type { Logger } from '../src/logger.js'
import type { DockerWorkload } from '../src/docker-capability.js'
import { DEFAULT_HARNESS_PORT, harnessListenPort } from '../src/harness-port.js'

// The block the harness appends to every agent's system prompt: what this machine HAS, so no
// agent pays to find out. The property the whole thing turns on is that its three answers stay
// three: a failed probe may never render as an absence, because "python3 is not installed" and
// "we could not tell whether python3 is installed" lead an agent to opposite next moves.
//
// Docker has FIVE, for the same reason one level in: a daemon that answers is not a daemon that
// works, and the block used to state the second off the first (issue #2120).

/** A runner answering from a table, so every branch is drivable without the real binaries. */
function fakeRunner(table: Record<string, ProbeResult>): ProbeRunner {
  return async (command, args) => {
    const key = [command, ...args].join(' ')
    return table[key] ?? table[command] ?? { outcome: 'missing' }
  }
}

const RAN = (output: string): ProbeResult => ({ outcome: 'ran', exitCode: 0, output })

/**
 * Workload answers, injected into every pass that reaches a reachable daemon.
 *
 * Injected rather than defaulted because the real one starts a container: a suite that let it run
 * would grade the machine it happens to run on, which is the failure mode this whole file exists
 * to close. `ranAContainer` is the neutral one, used wherever the case under test is about the
 * REACHABILITY probe and not about what the daemon can then do.
 */
const ranAContainer = async (): Promise<DockerWorkload> => ({ status: 'usable' })
const ranNothing = async (): Promise<DockerWorkload> => ({
  status: 'unusable',
  detail: 'failed to mount overlay: invalid argument',
})
const couldNotTell = async (): Promise<DockerWorkload> => ({
  status: 'unknown',
  reason: 'the platform ships no probe payload here',
})

describe('classifying one probe', () => {
  it('reads a clean exit as installed, with the version off the banner', () => {
    expect(toolPresence(RAN('git version 2.47.2\n'))).toEqual({
      status: 'present',
      version: '2.47.2',
    })
    expect(toolPresence(RAN('v26.7.0\n'))).toEqual({ status: 'present', version: '26.7.0' })
  })

  it('reads a NON-ZERO exit as installed too: the binary ran', () => {
    // `helm version` on a host with no cluster config, `kubectl version --client` on an old
    // client. The tool is there; it disliked the invocation.
    expect(toolPresence({ outcome: 'ran', exitCode: 1, output: 'v3.16.2' })).toEqual({
      status: 'present',
      version: '3.16.2',
    })
  })

  it('reads ENOENT as absent and a failed spawn as UNKNOWN, never the other way round', () => {
    expect(toolPresence({ outcome: 'missing' })).toEqual({ status: 'absent' })
    expect(toolPresence({ outcome: 'failed', reason: 'the probe timed out' })).toEqual({
      status: 'unknown',
      reason: 'the probe timed out',
    })
  })

  it('states a tool that ran but printed no version, rather than dropping it', () => {
    expect(toolPresence(RAN('jq is here'))).toEqual({ status: 'present' })
  })
})

describe('the docker daemon reads the same probe result differently', () => {
  it('takes a non-zero `docker info` as NO reachable daemon', () => {
    // The half-truth this replaces: `command -v docker` succeeds in the harness image, and
    // `docker build` still fails. Only running `docker info` can tell them apart, and its
    // non-zero exit IS the answer rather than proof the CLI is installed.
    expect(daemonPresence({ outcome: 'ran', exitCode: 1, output: 'Cannot connect' })).toEqual({
      status: 'absent',
    })
    expect(daemonPresence(RAN('28.0.1'))).toEqual({ status: 'present', version: '28.0.1' })
  })

  it('keeps a failed daemon probe unknown', () => {
    expect(daemonPresence({ outcome: 'failed', reason: 'the probe timed out' })).toEqual({
      status: 'unknown',
      reason: 'the probe timed out',
    })
  })

  it('will not answer for the daemon off a LOCATED cli', () => {
    // `found` is the Windows fallback's outcome: the platform's oracle located the binary and ran
    // NOTHING. As a synthesised `ran` with `exitCode: 0` it made `where docker` sufficient to tell
    // an agent `docker build` works here, which is the exact half-truth the file exists to remove.
    // A tool's presence is answerable that way; a daemon's reachability is not.
    expect(toolPresence({ outcome: 'found' })).toEqual({ status: 'present' })
    expect(daemonPresence({ outcome: 'found' }).status).toBe('unknown')
  })
})

describe('reading the Windows `where` oracle', () => {
  // The fallback the native transport needs, and the two ways it lied. Asserted as pure logic so
  // every branch runs on every platform: the failing branch needs a process whose PATH cannot reach
  // `where`, and mutating the live PATH to make one leaks into the next test.
  it('reports a LOCATED tool as found, never as a run that returned zero', () => {
    // `{ ran, exitCode: 0 }` here was the whole bug: the oracle discards the args, so a fabricated
    // clean exit answered for probes nobody executed. `docker info` reading it that way told agents
    // `docker build` works here on the strength of `where docker` alone.
    expect(readOracle(RAN('C:\\tools\\npm.cmd'))).toEqual({ outcome: 'found' })
  })

  it('reports `where` exiting non-zero as the tool being absent', () => {
    expect(readOracle({ outcome: 'ran', exitCode: 1, output: '' })).toEqual({ outcome: 'missing' })
  })

  it('does not read the ORACLE being unavailable as the TOOL being absent', () => {
    // A `missing` here is `where` itself not on PATH. Returned unchanged it became the tool's
    // absence, so a fully installed npm landed on the line an agent reads as "not here".
    expect(readOracle({ outcome: 'missing' })).toEqual({
      outcome: 'failed',
      reason: 'the tool could not be spawned, and `where` could not be run to locate it',
    })
    expect(toolPresence(readOracle({ outcome: 'missing' })).status).toBe('unknown')
  })

  it('carries a failed oracle through with its own reason', () => {
    expect(readOracle({ outcome: 'failed', reason: 'the probe timed out' })).toEqual({
      outcome: 'failed',
      reason: 'the probe timed out',
    })
  })
})

describe('probing the machine', () => {
  /** No daemon configured and no waiting, so a case says which branch it is testing. */
  const noDaemon = { daemonExpected: false, sleep: async () => {}, workload: ranAContainer }

  it('reports no daemon when the CLI is not there, having asked docker itself', async () => {
    // The CLI's absence is not consulted through the tool list any more: `docker info` returning
    // `missing` IS that answer, which is what let the two probes run concurrently. Asserted as the
    // verdict rather than as "did not ask", because asking is now the mechanism.
    const run = vi.fn<ProbeRunner>(async () => ({ outcome: 'missing' }))
    const inventory = await probeEnvironment(run, noDaemon)
    expect(inventory.dockerDaemon).toEqual({ status: 'absent' })
  })

  it('leaves the daemon UNKNOWN when the probe itself failed', async () => {
    const inventory = await probeEnvironment(
      fakeRunner({ docker: { outcome: 'failed', reason: 'the probe timed out' } }),
      noDaemon,
    )
    expect(inventory.dockerDaemon.status).toBe('unknown')
  })

  it('reads a reachable daemon off `docker info`', async () => {
    const inventory = await probeEnvironment(
      fakeRunner({
        'docker --version': RAN('Docker version 28.0.1, build abc'),
        'docker info --format {{.ServerVersion}}': RAN('28.0.1'),
      }),
      noDaemon,
    )
    expect(inventory.dockerDaemon).toEqual({ status: 'usable', server: '28.0.1' })
  })

  it('does not read a trimmed probe list as an absent daemon', async () => {
    // The list is curated and the file invites trimming it. Reading the CLI's presence back out of
    // `tools` defaulted a missing entry to `absent`, so dropping the `docker` entry would have had
    // the block state "NO Docker daemon is reachable" with nothing ever asked. Nothing derives the
    // daemon from the list now, so the verdict tracks what docker said and not what was listed.
    const inventory = await probeEnvironment(
      fakeRunner({ 'docker info --format {{.ServerVersion}}': RAN('28.0.1') }),
      noDaemon,
    )
    expect(inventory.tools.some((t) => t.name === 'docker')).toBe(true)
    expect(inventory.dockerDaemon.status).toBe('usable')
  })

  it('splits a reachable daemon by what a real container did on it', async () => {
    // The defect this file is about. `docker info` exiting 0 proves a daemon ANSWERS; a rootless
    // daemon nested in a sandbox answers throughout while no image layer can be mounted.
    const reachable = fakeRunner({ 'docker info --format {{.ServerVersion}}': RAN('29.7.2') })
    expect(
      (await probeEnvironment(reachable, { ...noDaemon, workload: ranNothing })).dockerDaemon,
    ).toEqual({
      status: 'unusable',
      server: '29.7.2',
      detail: 'failed to mount overlay: invalid argument',
    })
    expect(
      (await probeEnvironment(reachable, { ...noDaemon, workload: couldNotTell })).dockerDaemon,
    ).toEqual({
      status: 'serving',
      server: '29.7.2',
      reason: 'the platform ships no probe payload here',
    })
  })

  it('does not start a container for a daemon nothing can reach', async () => {
    // The workload check costs a container start. There is nothing to start it on when the daemon
    // is absent or undetermined, and asking anyway would put that cost on the critical path of
    // every job on a machine with no docker at all.
    const workload = vi.fn(ranAContainer)
    await probeEnvironment(async () => ({ outcome: 'missing' }), { ...noDaemon, workload })
    expect(workload).not.toHaveBeenCalled()
  })

  it('runs the tool pass and the daemon pass CONCURRENTLY, not one after the other', async () => {
    // Both ceilings used to sit end to end on the critical path, ahead of the clone, on every
    // dispatch. Asserted by overlap rather than by wall-clock: the daemon probe must be in flight
    // while a tool probe is still unresolved.
    let releaseTools = (): void => {}
    const toolsHeld = new Promise<void>((resolve) => {
      releaseTools = resolve
    })
    let daemonAsked = false
    const run: ProbeRunner = async (command, args) => {
      if (args.includes('info')) {
        daemonAsked = true
        releaseTools()
        return RAN('28.0.1')
      }
      await toolsHeld
      return RAN('1.0.0')
    }
    const inventory = await probeEnvironment(run, noDaemon)
    expect(daemonAsked).toBe(true)
    expect(inventory.dockerDaemon.status).toBe('usable')
  })
})

describe('a daemon that is still coming up', () => {
  // The deadliest shape this block had. `entrypoint.sh` starts the rootless daemon detached and
  // execs the server without waiting, so the backend dispatches seconds before there is a socket
  // and `docker info` is refused AT ONCE (the 10s ceiling it was once sized against never fires).
  // Rendered as a plain absence, that told every agent `docker compose up` "will fail here
  // whatever the CLI reports" on a machine whose daemon was up moments later.
  const refused: ProbeResult = { outcome: 'ran', exitCode: 1, output: 'Cannot connect' }

  it('retries, then says it could not be determined, when a daemon IS configured here', async () => {
    const run = vi.fn<ProbeRunner>(async () => refused)
    const slept: number[] = []
    const inventory = await probeEnvironment(run, {
      daemonExpected: true,
      workload: ranAContainer,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    expect(inventory.dockerDaemon.status).toBe('unknown')
    expect(slept).toHaveLength(1)
    const asked = run.mock.calls.filter((call) => call[1].includes('info'))
    expect(asked).toHaveLength(2)
    // And the agent is told to try it rather than told not to.
    const text = renderEnvironmentInventory({
      tools: [],
      dockerDaemon: inventory.dockerDaemon,
      harnessPort: DEFAULT_HARNESS_PORT,
    })
    expect(text).not.toContain('NO Docker daemon')
    expect(text).toContain('try it if you need it')
  })

  it('takes the retry as the answer when the daemon comes up between the two', async () => {
    let asked = 0
    const run: ProbeRunner = async (_command, args) => {
      if (!args.includes('info')) return { outcome: 'missing' }
      asked += 1
      return asked === 1 ? refused : RAN('28.0.1')
    }
    const inventory = await probeEnvironment(run, {
      daemonExpected: true,
      workload: ranAContainer,
      sleep: async () => {},
    })
    expect(inventory.dockerDaemon).toEqual({ status: 'usable', server: '28.0.1' })
  })

  it('keeps a plain ABSENCE where no daemon was ever coming', async () => {
    // The developer's laptop with Docker Desktop shut down, and the image branch that starts no
    // rootless daemon at all. Nothing is going to answer, so the definite statement is the honest
    // one, and this is the case the whole `docker info` probe was added for.
    const run = vi.fn<ProbeRunner>(async () => refused)
    const inventory = await probeEnvironment(run, {
      daemonExpected: false,
      workload: ranAContainer,
      sleep: async () => {},
    })
    expect(inventory.dockerDaemon).toEqual({ status: 'absent' })
    expect(run.mock.calls.filter((call) => call[1].includes('info'))).toHaveLength(1)
  })
})

describe('rendering the inventory', () => {
  const inventory = (
    tools: EnvironmentInventory['tools'],
    dockerDaemon: EnvironmentInventory['dockerDaemon'],
    harnessPort = DEFAULT_HARNESS_PORT,
  ): EnvironmentInventory => ({ tools, dockerDaemon, harnessPort })

  it('renders a failed probe as neither present nor absent', () => {
    const text = renderEnvironmentInventory(
      inventory(
        [
          { name: 'node', showVersion: true, presence: { status: 'present', version: '26.7.0' } },
          { name: 'python3', showVersion: true, presence: { status: 'absent' } },
          {
            name: 'make',
            showVersion: false,
            presence: { status: 'unknown', reason: 'the probe timed out' },
          },
        ],
        { status: 'absent' },
      ),
    )
    expect(text).toContain('Installed: node 26.7.0.')
    expect(text).toContain('Not installed: python3.')
    expect(text).toMatch(/neither present nor absent: make \(the probe timed out\)/)
    // The property, stated as the failure it prevents: an unknown tool must not appear on the
    // line an agent reads as "the platform says this is not here".
    expect(text).not.toMatch(/Not installed:[^\n]*make/)
  })

  it('bounds itself: an unlisted tool is unknown, not absent', () => {
    const text = renderEnvironmentInventory(inventory([], { status: 'absent' }))
    expect(text).toContain('Nothing else was probed.')
    expect(text).toMatch(/unknown to the platform rather than missing/)
  })

  it('closes on a FACT, and asks for no tool call after it', () => {
    // This block lands after the effort-report directive, whose closing sentences are the prompt's
    // ordering rule: write the sentinel, then reply, and no tool call after the reply. The closing
    // line used to say "check for that one yourself before relying on it", an errand positioned
    // after the rule that forbids one. When to go looking is the sandbox directive's business, and
    // that directive is not last. Kept as a property so a future line cannot reintroduce one.
    const text = renderEnvironmentInventory(inventory([], { status: 'absent' }))
    expect(text.trimEnd().endsWith('rather than missing.')).toBe(true)
    expect(text).not.toMatch(/check for (that|it) (one )?yourself/i)
  })

  it('forbids the SYSTEM install without forbidding a project-local package manager', () => {
    // `pnpm` is not on the base image (only the UI variant installs it), so this line routinely
    // names the package manager the job's own repo declares. A flat "do not try to install one of
    // these" told the agent not to reach for the one route an unprivileged user has, and the
    // observed fallback is `npm install` against a pnpm lockfile.
    const text = renderEnvironmentInventory(
      inventory([{ name: 'pnpm', showVersion: true, presence: { status: 'absent' } }], {
        status: 'absent',
      }),
    )
    expect(text).toContain('Not installed: pnpm.')
    expect(text).toMatch(/SYSTEM install/)
    expect(text).toMatch(/npx <manager>/)
    expect(text).not.toMatch(/Do not try to install one of these/)
  })

  it('says what a reachable daemon means and what an unreachable one means', () => {
    const up = renderEnvironmentInventory(inventory([], { status: 'usable', server: '28.0.1' }))
    expect(up).toContain('A Docker daemon is reachable (server 28.0.1)')
    expect(up).toContain('`docker build`, `docker run` and `docker compose up` work here')

    const down = renderEnvironmentInventory(inventory([], { status: 'absent' }))
    expect(down).toContain('NO Docker daemon is reachable')
    // The point of stating it at all: the agent must produce the artifact anyway. Without this
    // half, a coder and its reviewer each spent rounds on the wording of the disclosure.
    expect(down).toMatch(/Produce the Dockerfile or compose file you were asked for/)

    const unsure = renderEnvironmentInventory(
      inventory([], { status: 'unknown', reason: 'the probe timed out' }),
    )
    expect(unsure).toContain('could not be determined (the probe timed out)')
    expect(unsure).not.toContain('NO Docker daemon')
  })

  it('claims the commands work ONLY where a container was actually run', () => {
    // Issue #2120, as one assertion. Every state other than `usable` reaches an agent that was
    // also told not to spend turns re-checking any of this, so the claim has to be earned by the
    // one thing that proves it.
    const claim = '`docker build`, `docker run` and `docker compose up` work here'
    for (const daemon of [
      { status: 'unusable' as const, server: '29.7.2', detail: 'failed to mount overlay' },
      { status: 'serving' as const, server: '29.7.2', reason: 'no payload here' },
      { status: 'unknown' as const, reason: 'the probe timed out' },
      { status: 'absent' as const },
    ]) {
      expect(renderEnvironmentInventory(inventory([], daemon))).not.toContain(claim)
    }
  })

  it('tells an agent to stop, and why, when the daemon cannot run a container', () => {
    const text = renderEnvironmentInventory(
      inventory([], {
        status: 'unusable',
        server: '29.7.2',
        detail: 'failed to mount overlayfs: invalid argument',
      }),
    )
    // Reachable AND unusable, both said: an agent told only "no docker" would have watched
    // `docker info` succeed and concluded the platform was wrong about its own machine.
    expect(text).toContain('A Docker daemon is reachable (server 29.7.2) but it CANNOT run')
    expect(text).toContain('failed to mount overlayfs: invalid argument')
    expect(text).toContain('nothing to retry')
    expect(text).toMatch(/Produce the Dockerfile or compose file you were asked for/)
  })

  it('keeps "answered" and "works" apart when the workload check could not be run', () => {
    // The developer's laptop under LOCAL_NATIVE_AGENTS, where there is no probe payload. Docker
    // there usually works, so the honest line is one cheap check, not a prohibition.
    const text = renderEnvironmentInventory(
      inventory([], { status: 'serving', server: '28.0.1', reason: 'no probe payload here' }),
    )
    expect(text).toContain('was NOT established (no probe payload here)')
    expect(text).toContain('Try it if you need it')
    expect(text).not.toContain('CANNOT run')
    expect(text).not.toContain('NO Docker daemon')
  })

  it('omits a version where presence is the whole answer', () => {
    const text = renderEnvironmentInventory(
      inventory(
        [{ name: 'jq', showVersion: false, presence: { status: 'present', version: '1.7' } }],
        { status: 'absent' },
      ),
    )
    expect(text).toContain('Installed: jq.')
  })
})

/** A logger whose lines the test can read back, so a degraded pass is asserted rather than assumed. */
function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  const logger: Logger & { warnings: string[] } = {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
    child: () => logger,
  }
  return logger
}

describe('folding the inventory onto a system prompt', () => {
  it('appends the block after the role prompt, keeping the prompt itself intact', async () => {
    const prompt = await appendEnvironmentInventory('ROLE PROMPT', {
      log: recordingLogger(),
      run: fakeRunner({ node: RAN('v26.7.0') }),
    })
    expect(prompt.startsWith('ROLE PROMPT\n\n')).toBe(true)
    expect(prompt).toContain('ENVIRONMENT INVENTORY')
  })

  it('dispatches without a block rather than failing the job when the pass falls over', async () => {
    const logger = recordingLogger()
    const prompt = await appendEnvironmentInventory('ROLE PROMPT', {
      log: logger,
      run: async () => {
        throw new Error('spawn subsystem is gone')
      },
    })
    // An inventory is context. Losing it costs the agent a few probes; failing the job here
    // would cost the run, and the outage is stated in a log line rather than swallowed.
    expect(prompt).toBe('ROLE PROMPT')
    expect(logger.warnings.join(' ')).toContain('without an inventory')
  })
})

describe('the real spawn runner', () => {
  it('classifies a binary that is not on PATH as missing, not as a probe failure', async () => {
    const run = spawnProbeRunner()
    const result = await run('cat-factory-no-such-binary-xyz', ['--version'])
    expect(result.outcome).toBe('missing')
  })

  it('reports a real toolchain binary as having run', async () => {
    // `node` is running this test, so it is the one binary the suite can assert on whatever
    // machine (or CI runner, or developer's Windows box) it executes on.
    const result = await spawnProbeRunner()(process.execPath, ['--version'])
    expect(result.outcome).toBe('ran')
    expect(toolPresence(result)).toEqual({
      status: 'present',
      version: process.versions.node,
    })
  })

  it('states a cancelled job in WORDS, never as the errno it arrives as', async () => {
    // Every reason is rendered verbatim into a model's system prompt. An aborted pass rejects with
    // an `AbortError` carrying no `killed`, so it fell through to a catch-all that stringified
    // `e.code`, and all thirteen entries read "node (ABORT_ERR), npm (ABORT_ERR), ...".
    const result = await spawnProbeRunner(AbortSignal.abort())(process.execPath, ['--version'])
    expect(result).toEqual({
      outcome: 'failed',
      reason: 'the job was cancelled before the probe finished',
    })
    const presence = toolPresence(result)
    expect(presence.status === 'unknown' && presence.reason).not.toMatch(/[A-Z]{3,}_[A-Z]+/)
  })
})

describe('a shell-script binary on a Windows host', () => {
  // Guarded with `skipIf` rather than an early `return` inside the body: the body spawns a real
  // process, so returning after it charged every non-Windows CI runner for a probe and then
  // reported green having asserted nothing, which reads in the output as a case that ran.
  const windowsOnly = process.platform !== 'win32'

  it.skipIf(windowsOnly)(
    'is not reported as missing just because execFile cannot spawn a .cmd',
    async () => {
      // The native transport runs this on the developer's own machine, where `npm` and `pnpm` are
      // `.cmd` shims `execFile` (no shell) will not spawn. Left alone, a fully installed toolchain
      // would be stated to the agent as NOT INSTALLED, which is the one thing the block may never
      // get wrong.
      const run = spawnProbeRunner()
      const result = await run('npm', ['--version'])
      // `found`, specifically, and not merely "not missing": the fallback LOCATED the shim without
      // running it. A `ran` here would mean it had invented an exit code it never saw, which is
      // what let the daemon probe answer off `where docker`.
      expect(result.outcome).toBe('found')
      expect(toolPresence(result)).toEqual({ status: 'present' })
    },
  )

  it.skipIf(windowsOnly)('gives a probe whose ANSWER is its exit code no answer', async () => {
    // The half-truth this file exists to prevent, in its last hiding place: `docker` is a `.cmd` on
    // plenty of Windows installs (podman, scoop and winget wrappers), so `docker info` ENOENTs, the
    // fallback locates the shim, and a synthesised `exitCode: 0` said the daemon was reachable.
    //
    // Driven through `npm`, not `docker`, and deliberately: docker is a real `.exe` on a stock
    // Docker Desktop box, so a docker-shaped case would take the early-return branch and assert
    // nothing on the machine most likely to run this. `npm` is `.cmd` wherever Node is installed
    // on Windows, so the fallback is guaranteed to be the path under test. What is asserted is the
    // composition: the runner reports located-not-run, and the daemon classifier refuses to read
    // that as a reachable daemon whatever the binary was.
    const located = await spawnProbeRunner()('npm', ['--version'])
    expect(located.outcome).toBe('found')
    expect(daemonPresence(located).status).toBe('unknown')
  })
})

describe('the reserved-port line', () => {
  const bare = (harnessPort: number): string =>
    renderEnvironmentInventory({ tools: [], dockerDaemon: { status: 'absent' }, harnessPort })

  it('names the port the harness holds, and why a reply from it proves nothing', () => {
    // The whole point: an agent that reads this picks another port up front, and a tester that
    // probes this one knows the 200 it gets back is the platform answering, not the product.
    const text = bare(27182)
    expect(text).toContain('Port 27182 is already bound here')
    expect(text).toContain('{"status":"ok"}')
  })

  it('renders the port it is handed, never the default it was built with', () => {
    expect(bare(41234)).toContain('Port 41234 is already bound here')
    expect(bare(41234)).not.toContain(String(DEFAULT_HARNESS_PORT))
  })
})

// The renderer above is handed a number, so on its own it says nothing about WHICH number the
// inventory reports. That answer is resolved twice over, and both halves need their own assertion:
// `harnessListenPort` reads `PORT`, and `probeEnvironment` calls it when no port is injected. A
// regression collapsing either onto the default would leave every rendering test above green while
// the block named a port the harness does not hold, which is the one thing the line exists to say.
describe('the port the inventory reports', () => {
  const restore = { ...process.env }
  afterEach(() => {
    process.env = { ...restore }
  })

  it('is `PORT` when the deployment sets one', () => {
    // A deployment sets it per pod, and the native local transport picks an ephemeral port per
    // harness process and passes it this way.
    expect(harnessListenPort({ PORT: '41234' })).toBe(41234)
  })

  it('falls back to the default when nothing sets `PORT`', () => {
    expect(harnessListenPort({})).toBe(DEFAULT_HARNESS_PORT)
  })

  it('is what a probe with no injected port picks up from the environment', async () => {
    process.env.PORT = '41234'
    const inventory = await probeEnvironment(fakeRunner({}), {
      daemonExpected: false,
      sleep: async () => {},
    })
    expect(inventory.harnessPort).toBe(41234)
    expect(renderEnvironmentInventory(inventory)).toContain('Port 41234 is already bound here')
  })

  it('is the default for a probe on a deployment that sets no `PORT`', async () => {
    delete process.env.PORT
    const inventory = await probeEnvironment(fakeRunner({}), {
      daemonExpected: false,
      sleep: async () => {},
    })
    expect(inventory.harnessPort).toBe(DEFAULT_HARNESS_PORT)
  })
})
