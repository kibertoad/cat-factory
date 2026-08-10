import { describe, expect, it } from 'vitest'
import {
  COMMAND_NOT_FOUND,
  COMMAND_TIMED_OUT,
  type HostShell,
  type ShellResult,
} from './host-shell.js'
import {
  classifyIngress,
  DEFAULT_INGRESS_PORT,
  INGRESS_HOST_TEMPLATE,
  type IngressClassRead,
  ingressHostTemplate,
  ingressRemedies,
  ingressUrlPort,
  listIngressClassesCommand,
  parseIngressClasses,
  parsePublishedHostPorts,
  type PortPublication,
  type PortState,
  probeIngress,
  publishedPortsCommand,
  readIngressClasses,
  type TcpProbe,
} from './k3s-ingress.js'

function fakeTcp(state: PortState): TcpProbe {
  return { probe: () => Promise.resolve(state) }
}

/**
 * A shell scripted per COMMAND, keyed by its binary: the probe now issues a `kubectl` read and a
 * `docker` read together, so a positional queue would answer whichever landed first.
 */
function scriptShell(
  kubectl: Partial<ShellResult>[],
  docker: Partial<ShellResult> = { code: 1, stderr: 'No such container' },
): HostShell & { kubectlCalls: number; dockerCalls: number } {
  const queue = [...kubectl]
  const shell = {
    kubectlCalls: 0,
    dockerCalls: 0,
    run(cmd: string): Promise<ShellResult> {
      if (cmd === 'docker') {
        shell.dockerCalls++
        return Promise.resolve({
          code: docker.code ?? 0,
          stdout: docker.stdout ?? '',
          stderr: docker.stderr ?? '',
        })
      }
      shell.kubectlCalls++
      const hit = queue.length > 1 ? queue.shift() : queue[0]
      return Promise.resolve({
        code: hit?.code ?? COMMAND_NOT_FOUND,
        stdout: hit?.stdout ?? '',
        stderr: hit?.stderr ?? '',
      })
    },
  }
  return shell
}

/** A clock the fake sleep advances, so the WALL-CLOCK budget is what the test measures. */
function fakeClock(costPerProbeMs = 0): {
  now: () => number
  sleep: (ms: number) => Promise<void>
  tick: (ms: number) => void
} {
  let t = 0
  return {
    now: () => {
      t += costPerProbeMs
      return t
    },
    sleep: (ms) => {
      t += ms
      return Promise.resolve()
    },
    tick: (ms) => {
      t += ms
    },
  }
}

const TRAEFIK = JSON.stringify({
  items: [{ metadata: { name: 'traefik' }, spec: { controller: 'traefik.io/ingress-controller' } }],
})
const NO_CLASSES = JSON.stringify({ items: [] })

const READ_TRAEFIK: IngressClassRead = { ok: true, controllers: ['traefik'] }
const READ_NONE: IngressClassRead = { ok: true, controllers: [] }
const UNCHECKED: PortPublication = { checked: false }

describe('parseIngressClasses', () => {
  it('reads the controller, falling back to the class name', () => {
    expect(parseIngressClasses(TRAEFIK)).toEqual(['traefik.io/ingress-controller'])
    expect(
      parseIngressClasses(JSON.stringify({ items: [{ metadata: { name: 'nginx' } }] })),
    ).toEqual(['nginx'])
  })

  it('distinguishes an EMPTY list from an unreadable one', () => {
    // The distinction the whole three-state verdict rests on: `[]` is a definitive "no ingress
    // controller"; `null` is "this probe learned nothing".
    expect(parseIngressClasses(NO_CLASSES)).toEqual([])
    expect(parseIngressClasses('error: connection refused')).toBeNull()
    expect(parseIngressClasses('{}')).toBeNull()
  })
})

describe('readIngressClasses', () => {
  it('names WHICH failure stopped the read, because each needs a different fix', () => {
    // Folded into one "could not read the cluster's IngressClasses", all four got the same remedy
    // ("re-run once it has settled"), which fits none of them.
    expect(readIngressClasses({ code: COMMAND_NOT_FOUND, stdout: '', stderr: '' })).toMatchObject({
      ok: false,
      cause: 'kubectl-missing',
    })
    expect(readIngressClasses({ code: COMMAND_TIMED_OUT, stdout: '', stderr: '' })).toMatchObject({
      ok: false,
      cause: 'cluster-unreachable',
    })
    expect(
      readIngressClasses({
        code: 1,
        stdout: '',
        stderr: 'Error from server (Forbidden): cannot list',
      }),
    ).toMatchObject({ ok: false, cause: 'cluster-refused' })
    expect(readIngressClasses({ code: 0, stdout: 'not json', stderr: '' })).toMatchObject({
      ok: false,
      cause: 'unparseable',
    })
  })

  it("carries the cluster's OWN words for a refusal, the only actionable part of it", () => {
    const read = readIngressClasses({
      code: 1,
      stdout: '',
      stderr: 'Error from server (Forbidden): ingressclasses is forbidden\nsecond line',
    })
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.detail).toContain('Forbidden')
    // One line only: the rest of a kubectl error is stack-shaped noise in a terminal summary.
    expect(read.detail).not.toContain('second line')
  })
})

describe('parsePublishedHostPorts', () => {
  it('reads the host ports mapped to the ingress container port, ignoring the rest', () => {
    const out = parsePublishedHostPorts('6443/tcp -> 0.0.0.0:6443\n80/tcp -> 0.0.0.0:18080\n')
    expect(out).toEqual([18080])
  })

  it('does not read an IPv6 bind address as the port', () => {
    expect(parsePublishedHostPorts('80/tcp -> [::]:18080')).toEqual([18080])
  })

  it('answers empty for a container that publishes nothing', () => {
    expect(parsePublishedHostPorts('')).toEqual([])
    expect(parsePublishedHostPorts('6443/tcp -> 0.0.0.0:6443')).toEqual([])
  })
})

describe('publishedPortsCommand', () => {
  it('asks the container each distribution puts the forward on', () => {
    expect(publishedPortsCommand('k3d', 'mine').args).toEqual(['port', 'k3d-mine-serverlb'])
    expect(publishedPortsCommand('kind', 'mine').args).toEqual(['port', 'mine-control-plane'])
  })
})

describe('classifyIngress', () => {
  const port = DEFAULT_INGRESS_PORT

  it('is READY only when a controller answered and the host port is open', () => {
    expect(
      classifyIngress({
        port,
        classes: READ_TRAEFIK,
        hostPort: 'open',
        publication: UNCHECKED,
      }),
    ).toEqual({ status: 'ready', port, controller: 'traefik', attribution: 'unattributed' })
  })

  it('claims the port belongs to the CLUSTER only when the runtime confirmed it', () => {
    // A TCP connect proves something listens, not that the cluster does. The stronger claim needs
    // the container runtime's own port table.
    expect(
      classifyIngress({
        port,
        classes: READ_TRAEFIK,
        hostPort: 'open',
        publication: { checked: true, hostPorts: [port] },
      }),
    ).toMatchObject({ status: 'ready', attribution: 'cluster' })
  })

  it('is MISSING when the cluster publishes no such port, whatever answers on it', () => {
    // The exact false positive: a k3d cluster created without `-p`, plus an unrelated web server
    // on host 80. The socket says open; the cluster forwards nothing.
    expect(
      classifyIngress({
        port,
        classes: READ_TRAEFIK,
        hostPort: 'open',
        publication: { checked: true, hostPorts: [] },
      }),
    ).toMatchObject({ status: 'missing', gaps: ['hostPort'] })
  })

  it('names the port the cluster DOES publish, which is a much shorter fix', () => {
    expect(
      classifyIngress({
        port,
        classes: READ_TRAEFIK,
        hostPort: 'closed',
        publication: { checked: true, hostPorts: [18080] },
      }),
    ).toMatchObject({ status: 'missing', gaps: ['hostPort'], publishedOn: 18080 })
  })

  it('names each missing half separately, because each has its own fix', () => {
    expect(
      classifyIngress({ port, classes: READ_NONE, hostPort: 'open', publication: UNCHECKED }),
    ).toMatchObject({ status: 'missing', gaps: ['controller'] })
    expect(
      classifyIngress({ port, classes: READ_TRAEFIK, hostPort: 'closed', publication: UNCHECKED }),
    ).toMatchObject({ status: 'missing', gaps: ['hostPort'] })
    expect(
      classifyIngress({ port, classes: READ_NONE, hostPort: 'closed', publication: UNCHECKED }),
    ).toMatchObject({ status: 'missing', gaps: ['controller', 'hostPort'] })
  })

  it('is UNKNOWN when the cluster could not be read, whatever the port did, and says why', () => {
    const failed: IngressClassRead = { ok: false, cause: 'cluster-refused', detail: 'forbidden' }
    for (const hostPort of ['open', 'closed'] as const) {
      expect(
        classifyIngress({ port, classes: failed, hostPort, publication: UNCHECKED }),
      ).toMatchObject({ status: 'unknown', cause: 'cluster-refused', probeFailure: 'forbidden' })
    }
  })

  it('keeps an undecidable PORT out of the missing verdict, but not an absent controller', () => {
    // A filtered port is undecided; a cluster with no controller cannot serve the URL either way,
    // so that half stays a definitive `missing` rather than being softened to `unknown`.
    expect(
      classifyIngress({ port, classes: READ_TRAEFIK, hostPort: 'unknown', publication: UNCHECKED }),
    ).toMatchObject({ status: 'unknown', cause: 'host-port-filtered' })
    expect(
      classifyIngress({ port, classes: READ_NONE, hostPort: 'unknown', publication: UNCHECKED }),
    ).toMatchObject({ status: 'missing', gaps: ['controller'] })
  })
})

describe('ingressHostTemplate / ingressUrlPort', () => {
  it('withholds a template unless the ingress was established', () => {
    expect(
      ingressHostTemplate({
        status: 'ready',
        port: 80,
        controller: 'traefik',
        attribution: 'cluster',
      }),
    ).toBe(INGRESS_HOST_TEMPLATE)
    expect(ingressHostTemplate({ status: 'missing', port: 80, gaps: ['controller'] })).toBeNull()
    expect(
      ingressHostTemplate({ status: 'unknown', port: 80, cause: 'unparseable', probeFailure: 'x' }),
    ).toBeNull()
  })

  it('keeps the port OUT of the host, because the host is also the Ingress `host`', () => {
    // Kubernetes rejects a `spec.rules[].host` carrying a port, and the rendered template is what
    // a service's manifests must declare, so a non-default port travels as its own field.
    const ready = {
      status: 'ready',
      port: 8080,
      controller: 'traefik',
      attribution: 'cluster',
    } as const
    expect(ingressHostTemplate(ready)).toBe('{{branch}}.127.0.0.1.nip.io')
    expect(ingressHostTemplate(ready)).not.toContain(':')
    expect(ingressUrlPort(ready)).toBe(8080)
  })

  it('omits the default port, which the URL derivation composes without', () => {
    expect(
      ingressUrlPort({ status: 'ready', port: 80, controller: 'traefik', attribution: 'cluster' }),
    ).toBeNull()
    expect(ingressUrlPort({ status: 'missing', port: 8080, gaps: ['hostPort'] })).toBeNull()
  })
})

describe('ingressRemedies', () => {
  it('points a missing host port at the recreate command the CALLER could name', () => {
    const lines = ingressRemedies(
      { status: 'missing', port: 8080, gaps: ['hostPort'] },
      {
        runtime: 'k3d',
        recreateCommand: 'cat-factory k3s --recreate --runtime k3d --cluster-name mine',
      },
    ).join('\n')
    // A published host port cannot be added to a running cluster, so a `docker` incantation here
    // would be advice that cannot work.
    expect(lines).toContain('cat-factory k3s --recreate --runtime k3d --cluster-name mine')
  })

  it('WITHHOLDS a recreate line when there is no cluster the CLI could name', () => {
    // The reuse path against a cluster this command cannot rebuild. It used to print
    // `cat-factory k3s --recreate`, which `chooseOffer` then refused: an unactionable remedy.
    const lines = ingressRemedies({ status: 'missing', port: 80, gaps: ['hostPort'] }, {}).join(
      '\n',
    )
    expect(lines).not.toContain('--recreate')
    expect(lines).toContain('re-create it with the tool that made it')
  })

  it('sends a wrongly-published port at the flag, not at a rebuild', () => {
    const lines = ingressRemedies(
      { status: 'missing', port: 80, gaps: ['hostPort'], publishedOn: 18080 },
      { runtime: 'k3d', recreateCommand: 'cat-factory k3s --recreate' },
    ).join('\n')
    expect(lines).toContain('--ingress-port 18080')
    // Nothing needs destroying: the cluster already serves the URL, on another port.
    expect(lines).not.toContain('--recreate')
  })

  it('gives kind its own controller remedy, since kind ships none', () => {
    const kind = ingressRemedies(
      { status: 'missing', port: 80, gaps: ['controller'] },
      { runtime: 'kind' },
    ).join('\n')
    expect(kind).toContain('kind ships no ingress controller')
    const k3d = ingressRemedies(
      { status: 'missing', port: 80, gaps: ['controller'] },
      { runtime: 'k3d' },
    ).join('\n')
    // A k3d/k3s cluster with no Traefik was almost certainly created with --disable=traefik.
    expect(k3d).toContain('--disable=traefik')
  })

  it('offers nothing for a verified ingress', () => {
    expect(
      ingressRemedies({ status: 'ready', port: 80, controller: 'traefik', attribution: 'cluster' }),
    ).toEqual([])
  })

  it('gives each undecided CAUSE the remedy that fits it', () => {
    const remedyFor = (cause: 'kubectl-missing' | 'cluster-unreachable' | 'host-port-filtered') =>
      ingressRemedies({ status: 'unknown', port: 80, cause, probeFailure: 'x' }).join('\n')
    expect(remedyFor('kubectl-missing')).toContain('Install `kubectl`')
    expect(remedyFor('cluster-unreachable')).toContain('kubectl cluster-info')
    expect(remedyFor('host-port-filtered')).toContain('what is bound there')
    // The one fix that needs no cluster change reaches every negative verdict.
    expect(remedyFor('kubectl-missing')).toContain('Service status')
  })
})

describe('probeIngress', () => {
  it('reads the IngressClasses, the host port and the cluster port table together', async () => {
    const shell = scriptShell([{ code: 0, stdout: TRAEFIK }], {
      code: 0,
      stdout: '80/tcp -> 0.0.0.0:80',
    })
    const readiness = await probeIngress(
      { shell, tcp: fakeTcp('open') },
      { port: 80, cluster: { runtime: 'k3d', clusterName: 'mine' } },
    )
    expect(readiness).toEqual({
      status: 'ready',
      port: 80,
      controller: 'traefik.io/ingress-controller',
      attribution: 'cluster',
    })
    expect(shell.kubectlCalls).toBe(1)
    expect(shell.dockerCalls).toBe(1)
  })

  it('skips the publication read when no cluster can be named', async () => {
    const shell = scriptShell([{ code: 0, stdout: TRAEFIK }])
    const readiness = await probeIngress({ shell, tcp: fakeTcp('open') }, { port: 80 })
    expect(readiness).toMatchObject({ status: 'ready', attribution: 'unattributed' })
    expect(shell.dockerCalls).toBe(0)
  })

  it('treats an unreadable port table as UNCHECKED, never as "publishes nothing"', async () => {
    // A `--no-lb` k3d cluster has no load-balancer container at all; reading that failure as a
    // definitive negative would send an operator to rebuild a cluster whose port was fine.
    const shell = scriptShell([{ code: 0, stdout: TRAEFIK }], { code: 1, stderr: 'No such object' })
    const readiness = await probeIngress(
      { shell, tcp: fakeTcp('open') },
      { port: 80, cluster: { runtime: 'k3d', clusterName: 'mine' } },
    )
    expect(readiness).toMatchObject({ status: 'ready', attribution: 'unattributed' })
  })

  it('WAITS for a freshly created cluster to install its bundled controller', async () => {
    // Verified against k3d 5.7.5: `k3d cluster create` returns ~20-30s before the Traefik
    // HelmChart Job completes, so a single immediate read reports a definitive `missing` for a
    // cluster that is merely still starting: the same class of lie this module removes.
    const shell = scriptShell([
      { code: 0, stdout: NO_CLASSES },
      { code: 0, stdout: NO_CLASSES },
      { code: 0, stdout: TRAEFIK },
    ])
    const clock = fakeClock()
    const readiness = await probeIngress(
      { shell, tcp: fakeTcp('open'), sleep: clock.sleep, now: clock.now },
      { port: 80, waitMs: 10_000 },
    )
    expect(readiness.status).toBe('ready')
    expect(shell.kubectlCalls).toBe(3)
  })

  it('charges each ATTEMPT against the wait, not just the sleeps between them', async () => {
    // The budget is wall clock. Counting only the sleeps let a probe that itself costs seconds (a
    // 2s port timeout plus a 5s apiserver request) ride for free, so a documented 90s wait ran for
    // minutes: 46 attempts regardless of what each one took.
    const shell = scriptShell([{ code: 0, stdout: NO_CLASSES }])
    const clock = fakeClock(4_000)
    await probeIngress(
      { shell, tcp: fakeTcp('closed'), sleep: clock.sleep, now: clock.now },
      { port: 80, waitMs: 10_000 },
    )
    // 10s of budget against ~4s attempts plus 2s sleeps: two attempts, not five.
    expect(shell.kubectlCalls).toBeLessThanOrEqual(2)
  })

  it('reports the LAST verdict when the wait runs out, rather than pretending', async () => {
    const shell = scriptShell([{ code: 0, stdout: NO_CLASSES }])
    const clock = fakeClock()
    const readiness = await probeIngress(
      { shell, tcp: fakeTcp('closed'), sleep: clock.sleep, now: clock.now },
      { port: 80, waitMs: 4_000 },
    )
    expect(readiness).toMatchObject({ status: 'missing', gaps: ['controller', 'hostPort'] })
  })

  it('does not wait at all on the reuse path (waitMs defaults to 0)', async () => {
    const shell = scriptShell([{ code: 0, stdout: NO_CLASSES }])
    await probeIngress({ shell, tcp: fakeTcp('closed') }, { port: 80 })
    expect(shell.kubectlCalls).toBe(1)
  })
})

describe('listIngressClassesCommand', () => {
  it('targets a specific context when one is supplied, and carries a request timeout', () => {
    expect(listIngressClassesCommand().args).toEqual([
      'get',
      'ingressclass',
      '-o',
      'json',
      '--request-timeout=5s',
    ])
    expect(listIngressClassesCommand('k3d-x').args.slice(-2)).toEqual(['--context', 'k3d-x'])
  })
})
