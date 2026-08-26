import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  buildImage,
  dockerAvailable,
  freePort,
  IMAGE,
  removeContainer,
  startBareContainer,
  waitForHealth,
} from './support'

// What the IMAGE actually contains, asserted against the built image rather than against the
// Dockerfile that is supposed to produce it. Every check here corresponds to something that
// shipped broken and could not have been caught anywhere else:
//
//   - `dockerd` was absent for months (the image installed the rootless WRAPPERS and never the
//     daemon), so the Tester's local-infra stand-up degraded to a no-infra run everywhere.
//   - `NODE_ENV=production` was baked image-wide, so `npm install` in an agent's checkout omitted
//     devDependencies and a measured coder run spent six of forty tool calls undoing it.
//   - `python3`, `jq` and `rg` were missing, and agents reach for all three by reflex.
//
// A Dockerfile assertion would pass on any of those: what matters is the resolved image, so each
// check runs a command IN it.

const docker = dockerAvailable()

/** Run a command in a throwaway container off the built image and return its stdout. */
function inImage(...command: string[]): string {
  return execFileSync(
    'docker',
    ['run', '--rm', '--entrypoint', command[0]!, IMAGE, ...command.slice(1)],
    {
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
}

describe.skipIf(!docker)('executor image inventory', () => {
  beforeAll(() => {
    buildImage()
  })

  // The reflex binaries plus the ones a rootless daemon needs. `dockerd` and `ip` are the two the
  // shipped image lacked, and each failed at a different point of the same boot.
  it.each([
    ['git', ['git', '--version']],
    ['python3', ['python3', '--version']],
    ['jq', ['jq', '--version']],
    ['ripgrep', ['rg', '--version']],
    ['ps', ['ps', '--version']],
    ['ip', ['ip', '-V']],
    ['dockerd', ['dockerd', '--version']],
    ['containerd', ['containerd', '--version']],
    ['docker', ['docker', '--version']],
    ['dockerd-rootless.sh', ['sh', '-c', 'command -v dockerd-rootless.sh']],
    ['slirp4netns', ['sh', '-c', 'command -v slirp4netns']],
  ])('ships %s', (_name, command) => {
    expect(inImage(...command).trim()).not.toBe('')
  })

  // The pair that makes the NODE_ENV fix true rather than merely moved: the harness process must
  // still run in production mode, and nothing it spawns into the agent's checkout may inherit it.
  it('does not bake NODE_ENV into the image', () => {
    expect(inImage('sh', '-c', 'echo "[${NODE_ENV:-unset}]"').trim()).toBe('[unset]')
  })
})

describe.skipIf(!docker)('executor container boot', () => {
  const containers: string[] = []
  beforeAll(() => {
    buildImage()
  })
  afterAll(() => {
    for (const name of containers.splice(0)) removeContainer(name)
  })

  it('reports a docker verdict on /health rather than leaving every agent to probe', async () => {
    const hostPort = await freePort()
    const name = `cf-acc-inventory-${Date.now()}`
    containers.push(name)
    startBareContainer(name, hostPort)
    await waitForHealth(hostPort)

    const health = (await (await fetch(`http://127.0.0.1:${hostPort}/health`)).json()) as {
      docker?: { available?: boolean | null; source?: string; reason?: string; detail?: string }
    }
    // A CI runner may forbid the user namespaces rootless Docker needs, so the VERDICT is what is
    // asserted, not that it is `true`: what this pins is that the container reaches one and says
    // which daemon it is about. Asserting availability here would make the test a statement about
    // the runner's sandbox rather than about the image.
    expect(health.docker?.source).toBe('rootless')
    expect(typeof health.docker?.reason).toBe('string')

    // The daemon start is backgrounded so it never delays the boot, so give the bounded probe its
    // window to settle before reading the decided verdict.
    const deadline = Date.now() + 90_000
    let verdict: boolean | null | undefined
    do {
      await new Promise((r) => setTimeout(r, 2000))
      const again = (await (await fetch(`http://127.0.0.1:${hostPort}/health`)).json()) as {
        docker?: { available?: boolean | null }
      }
      verdict = again.docker?.available
    } while (verdict == null && Date.now() < deadline)
    expect(typeof verdict).toBe('boolean')

    // And it is the SAME verdict the harness reads when a job asks for a compose stand-up: one
    // recorded fact, not two probes that can disagree.
    const recorded = execFileSync(
      'docker',
      ['exec', name, 'cat', '/tmp/harness-docker-status.json'],
      { encoding: 'utf8', timeout: 30_000 },
    )
    expect((JSON.parse(recorded) as { available: boolean }).available).toBe(verdict)
  })

  it('runs the harness in production mode without handing that to the agent', async () => {
    const hostPort = await freePort()
    const name = `cf-acc-nodeenv-${Date.now()}`
    containers.push(name)
    startBareContainer(name, hostPort)
    await waitForHealth(hostPort)

    // PID 1 is the harness (see PROCESS_TITLE): its own env carries NODE_ENV=production...
    const harnessEnv = execFileSync(
      'docker',
      ['exec', name, 'sh', '-c', 'tr "\\0" "\\n" </proc/1/environ | grep ^NODE_ENV= || true'],
      { encoding: 'utf8', timeout: 30_000 },
    )
    expect(harnessEnv.trim()).toBe('NODE_ENV=production')

    // ...while nothing else in the container does: a shell started from the IMAGE env sees none.
    // (The agent's own shell descends from the harness instead, and `agentChildEnv` strips it
    // there — pinned by the unit suite, which can observe a spawned child's environment.)
    const shellEnv = execFileSync(
      'docker',
      ['exec', name, 'sh', '-c', 'echo "[${NODE_ENV:-unset}]"'],
      { encoding: 'utf8', timeout: 30_000 },
    )
    expect(shellEnv.trim()).toBe('[unset]')
  })
})
