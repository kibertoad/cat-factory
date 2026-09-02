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
    // buildx IS `docker build` now: without it both it and `docker compose build` die before
    // reading a Dockerfile, which an agent reads as its own build being wrong.
    ['docker buildx', ['docker', 'buildx', 'version']],
    // The shim for the spelling half the world's repo scripts still use.
    ['docker-compose', ['docker-compose', 'version', '--short']],
    // The payload the platform's own container check is built from. Statically linked, because
    // the probe image it goes into holds nothing else: no loader and no libc.
    ['busybox', ['/bin/busybox', 'echo', 'busybox-ok']],
  ])('ships %s', (_name, command) => {
    expect(inImage(...command).trim()).not.toBe('')
  })

  // `docker-compose version --short` prints a number, so the assertion above already proves the
  // shim runs. What it cannot show is that the shim reaches the PLUGIN rather than a v1 binary
  // nothing installed, which is the whole reason it exists.
  it('answers `docker-compose` with the compose plugin', () => {
    expect(inImage('docker-compose', 'version')).toContain('Docker Compose version')
  })

  // The image is off the containerd image store, whose snapshotter cannot mount inside a nested
  // user namespace and has no fallback (issue #2120). Asserted on the config the daemon reads,
  // since the daemon itself does not run in this stage.
  it('takes the rootless daemon off the containerd image store', () => {
    const config = inImage('cat', '/home/harness/.config/docker/daemon.json')
    expect(JSON.parse(config)).toEqual({ features: { 'containerd-snapshotter': false } })
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
      docker?: {
        available?: boolean | null
        source?: string
        reason?: string
        detail?: string
        workload?: { status?: string }
      }
    }
    // A CI runner may forbid the user namespaces rootless Docker needs, so the VERDICT is what is
    // asserted, not that it is `true`: what this pins is that the container reaches one and says
    // which daemon it is about. Asserting availability here would make the test a statement about
    // the runner's sandbox rather than about the image.
    expect(health.docker?.source).toBe('rootless')
    expect(typeof health.docker?.reason).toBe('string')
    // The other half of the block, and the one the boot record structurally cannot answer: what
    // it probes for is a SOCKET, and serving is not usable (issue #2120). Nothing has asked for
    // the daemon yet in a container this fresh, and that is its own word rather than a silence
    // that would read as a build with no answer to give.
    expect(health.docker?.workload?.status).toBe('unmeasured')

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

  // The inner budgets are sized to SUM to less than the case's own timeout, which is itself under
  // the suite's `testTimeout`. Boot plus `waitForHealth` (30s) plus the daemon wait (90s, the
  // entrypoint's 60s window and slack) plus the measurement (60s, against a check whose own
  // budget is 20s) leaves headroom on a runner that has fallen back to the `vfs` graphdriver, as
  // this image deliberately allows. Left to the suite default the case dies mid-`docker exec` and
  // reports a timeout instead of the verdict it exists to report.
  it('measures what the daemon can DO, and never rejects its own probe image', async () => {
    // The end-to-end half of issue #2120: an archive this repo assembles by hand, handed to a
    // real `docker load` and run as a real container. The unit suite can prove the tar parses
    // back; only a daemon can say whether it accepts it, and getting that wrong would have the
    // platform report a working daemon as one that cannot run containers.
    const hostPort = await freePort()
    const name = `cf-acc-workload-${Date.now()}`
    containers.push(name)
    startBareContainer(name, hostPort)
    await waitForHealth(hostPort)

    const deadline = Date.now() + 90_000
    let daemon: boolean | null | undefined
    do {
      await new Promise((r) => setTimeout(r, 2000))
      const health = (await (await fetch(`http://127.0.0.1:${hostPort}/health`)).json()) as {
        docker?: { available?: boolean | null }
      }
      daemon = health.docker?.available
    } while (daemon == null && Date.now() < deadline)

    // A `docker exec` starts from the IMAGE env, where DOCKER_HOST is deliberately empty (it is
    // the "no external daemon was wired in" signal the entrypoint branches on), so the rootless
    // socket has to be named here rather than inherited.
    const measured = execFileSync(
      'docker',
      [
        'exec',
        '-e',
        'DOCKER_HOST=unix:///home/harness/.docker/run/docker.sock',
        name,
        'node',
        '-e',
        "import('file:///app/dist/docker-capability.js')" +
          '.then((m) => m.measureDockerWorkload())' +
          '.then((v) => console.log(JSON.stringify(v)))',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    )
    const verdict = JSON.parse(measured.trim().split('\n').pop() ?? '{}') as {
      status?: string
      reason?: string
      detail?: string
    }
    expect(['usable', 'unusable', 'unknown']).toContain(verdict.status)

    // What the assertion is FOR. With no daemon there is nothing to measure and `unknown` is
    // the whole answer; with one, the archive must be something docker accepts, whatever it
    // then does with it. A rejected archive would be reported as could-not-determine, so the
    // failure this pins is silent rather than loud.
    if (daemon === true) {
      expect(verdict.reason ?? '').not.toContain('could not load its own probe image')
      // Nor may the check condemn a daemon over its own payload: every platform-side failure is
      // `unknown`, so a `docker exec` that reached a working daemon has no route to `unusable`
      // except the daemon actually refusing the container.
      expect(verdict.reason ?? '').not.toContain('probe binary')
    } else {
      expect(verdict.status).toBe('unknown')
    }
  }, 240_000)

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
