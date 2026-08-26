import { describe, expect, it, vi } from 'vitest'
import {
  appendEnvironmentInventory,
  daemonPresence,
  probeEnvironment,
  renderEnvironmentInventory,
  spawnProbeRunner,
  toolPresence,
  type EnvironmentInventory,
  type ProbeResult,
  type ProbeRunner,
} from '../src/environment-inventory.js'
import type { Logger } from '../src/logger.js'

// The block the harness appends to every agent's system prompt: what this machine HAS, so no
// agent pays to find out. The property the whole thing turns on is that its three answers stay
// three: a failed probe may never render as an absence, because "python3 is not installed" and
// "we could not tell whether python3 is installed" lead an agent to opposite next moves.

/** A runner answering from a table, so every branch is drivable without the real binaries. */
function fakeRunner(table: Record<string, ProbeResult>): ProbeRunner {
  return async (command, args) => {
    const key = [command, ...args].join(' ')
    return table[key] ?? table[command] ?? { outcome: 'missing' }
  }
}

const RAN = (output: string): ProbeResult => ({ outcome: 'ran', exitCode: 0, output })

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
})

describe('probing the machine', () => {
  it('does not ask the daemon anything when its CLI is not there', async () => {
    const run = vi.fn<ProbeRunner>(async () => ({ outcome: 'missing' }))
    const inventory = await probeEnvironment(run)
    expect(inventory.dockerDaemon).toEqual({ status: 'absent' })
    expect(run.mock.calls.some((call) => call[1].includes('info'))).toBe(false)
  })

  it('leaves the daemon UNKNOWN when the CLI probe itself failed', async () => {
    const inventory = await probeEnvironment(
      fakeRunner({ docker: { outcome: 'failed', reason: 'EACCES' } }),
    )
    expect(inventory.dockerDaemon.status).toBe('unknown')
  })

  it('asks the daemon once the CLI has answered', async () => {
    const inventory = await probeEnvironment(
      fakeRunner({
        'docker --version': RAN('Docker version 28.0.1, build abc'),
        'docker info --format {{.ServerVersion}}': RAN('28.0.1'),
      }),
    )
    expect(inventory.dockerDaemon).toEqual({ status: 'present', version: '28.0.1' })
  })
})

describe('rendering the inventory', () => {
  const inventory = (
    tools: EnvironmentInventory['tools'],
    dockerDaemon: EnvironmentInventory['dockerDaemon'],
  ): EnvironmentInventory => ({ tools, dockerDaemon })

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

  it('says what a reachable daemon means and what an unreachable one means', () => {
    const up = renderEnvironmentInventory(inventory([], { status: 'present', version: '28.0.1' }))
    expect(up).toContain('A Docker daemon is reachable (server 28.0.1)')

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
})

describe('a shell-script binary on a Windows host', () => {
  it('is not reported as missing just because execFile cannot spawn a .cmd', async () => {
    // The native transport runs this on the developer's own machine, where `npm` and `pnpm` are
    // `.cmd` shims `execFile` (no shell) will not spawn. Left alone, a fully installed toolchain
    // would be stated to the agent as NOT INSTALLED, which is the one thing the block may never
    // get wrong. Asserted through the real runner on the platform where it matters, and skipped
    // elsewhere, where there is no shim to miss.
    const run = spawnProbeRunner()
    const result = await run('npm', ['--version'])
    if (process.platform !== 'win32') return
    expect(result.outcome).not.toBe('missing')
  })
})
