import { describe, expect, it } from 'vitest'
import { COMMAND_NOT_FOUND, type HostShell, type ShellResult } from './host-shell.js'
import { classifyHost, type HostDetections, probeHost } from './k3s-probe.js'

/** A HostDetections with everything absent; override the fields a case cares about. */
function detections(overrides: Partial<HostDetections> = {}): HostDetections {
  return {
    kubectl: { installed: false },
    k3d: { installed: false },
    kind: { installed: false },
    k3s: { installed: false },
    docker: { installed: false, running: false },
    reachableCluster: false,
    k3dClusters: [],
    kindClusters: [],
    ...overrides,
  }
}

/** A fake shell: maps `` `${cmd} ${args.join(' ')}` `` → a canned result; unmapped ⇒ not found. */
function scriptShell(map: Record<string, Partial<ShellResult>>): HostShell {
  return {
    run(cmd, args) {
      const key = [cmd, ...args].join(' ')
      const hit = map[key]
      const result: ShellResult = hit
        ? { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
        : { code: COMMAND_NOT_FOUND, stdout: '', stderr: 'not found' }
      return Promise.resolve(result)
    },
  }
}

describe('classifyHost', () => {
  it('recommends reusing an existing reachable cluster', () => {
    const state = classifyHost(detections({ reachableCluster: true, clusterContext: 'k3d-dev' }))
    expect(state.recommended).toBe('use-existing')
    expect(state.offers.find((o) => o.id === 'use-existing')?.available).toBe(true)
    expect(state.offers.find((o) => o.id === 'use-existing')?.label).toContain('k3d-dev')
  })

  it('recommends creating a k3d cluster when Docker is running and k3d is installed', () => {
    const state = classifyHost(
      detections({ docker: { installed: true, running: true }, k3d: { installed: true } }),
    )
    expect(state.recommended).toBe('create-k3d')
    expect(state.offers.find((o) => o.id === 'create-k3d')?.available).toBe(true)
  })

  it('falls back to the guided k3s install when nothing usable is present', () => {
    const state = classifyHost(detections())
    expect(state.recommended).toBe('install-k3s')
    // install-k3s is always available (it only prints a command).
    expect(state.offers.find((o) => o.id === 'install-k3s')?.available).toBe(true)
  })

  it('explains why create-k3d is unavailable', () => {
    const dockerOffOnly = classifyHost(detections({ k3d: { installed: true } }))
    expect(dockerOffOnly.offers.find((o) => o.id === 'create-k3d')?.reason).toContain('Docker')

    const noK3d = classifyHost(detections({ docker: { installed: true, running: true } }))
    expect(noK3d.offers.find((o) => o.id === 'create-k3d')?.reason).toContain('k3d')
  })

  it('prefers an existing cluster over the k3d path when both are possible', () => {
    const state = classifyHost(
      detections({
        reachableCluster: true,
        docker: { installed: true, running: true },
        k3d: { installed: true },
      }),
    )
    expect(state.recommended).toBe('use-existing')
  })

  it('honors a `kind` runtime preference over the default k3d path', () => {
    const d = detections({
      docker: { installed: true, running: true },
      k3d: { installed: true },
      kind: { installed: true },
    })
    expect(classifyHost(d).recommended).toBe('create-k3d')
    expect(classifyHost(d, 'kind').recommended).toBe('create-kind')
  })

  it('offers create-kind with a reason when kind is missing', () => {
    const noKind = classifyHost(detections({ docker: { installed: true, running: true } }))
    const offer = noKind.offers.find((o) => o.id === 'create-kind')
    expect(offer?.available).toBe(false)
    expect(offer?.reason).toContain('kind')
  })

  it('a `k3s` preference favors the guided install over the Docker paths', () => {
    const state = classifyHost(
      detections({ docker: { installed: true, running: true }, k3d: { installed: true } }),
      'k3s',
    )
    expect(state.recommended).toBe('install-k3s')
  })

  it('labels the install offer as "start" when k3s is already installed', () => {
    const state = classifyHost(detections({ k3s: { installed: true } }))
    expect(state.offers.find((o) => o.id === 'install-k3s')?.label).toContain('already-installed')
  })
})

describe('probeHost', () => {
  it('detects a reachable cluster + installed tools from the shell', async () => {
    const shell = scriptShell({
      'kubectl version --output=json --request-timeout=3s': {
        code: 0,
        stdout: JSON.stringify({ serverVersion: { gitVersion: 'v1.30.0' } }),
      },
      'kubectl config current-context': { code: 0, stdout: 'k3d-cat-factory\n' },
      'k3d version': { code: 0, stdout: 'k3d version v5.6.0\n' },
      'k3d cluster list --output json': { code: 0, stdout: '[{"name":"cat-factory"}]' },
      'docker version --format {{.Server.Version}}': { code: 0, stdout: '27.0.0\n' },
    })
    const state = await probeHost(shell)
    expect(state.detections.reachableCluster).toBe(true)
    expect(state.detections.clusterContext).toBe('k3d-cat-factory')
    expect(state.detections.k3d.installed).toBe(true)
    expect(state.detections.k3d.version).toBe('k3d version v5.6.0')
    expect(state.detections.docker.running).toBe(true)
    expect(state.detections.k3dClusters).toEqual(['cat-factory'])
    expect(state.recommended).toBe('use-existing')
  })

  it('treats a missing binary (code 127) as not installed and no cluster', async () => {
    // Empty map ⇒ every command resolves to COMMAND_NOT_FOUND.
    const state = await probeHost(scriptShell({}))
    expect(state.detections.kubectl.installed).toBe(false)
    expect(state.detections.docker.installed).toBe(false)
    expect(state.detections.reachableCluster).toBe(false)
    expect(state.recommended).toBe('install-k3s')
    expect(COMMAND_NOT_FOUND).toBe(127)
  })

  it('reports Docker installed-but-not-running distinctly', async () => {
    const shell = scriptShell({
      'docker version --format {{.Server.Version}}': {
        code: 1,
        stderr: 'Cannot connect to the Docker daemon',
      },
      'k3d version': { code: 0, stdout: 'k3d version v5.6.0' },
    })
    const state = await probeHost(shell)
    expect(state.detections.docker.installed).toBe(true)
    expect(state.detections.docker.running).toBe(false)
    // k3d present but Docker down ⇒ create-k3d unavailable, guided k3s recommended.
    expect(state.offers.find((o) => o.id === 'create-k3d')?.available).toBe(false)
    expect(state.recommended).toBe('install-k3s')
  })
})
