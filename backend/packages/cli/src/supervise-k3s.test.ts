import { describe, expect, it } from 'vitest'
import type { HostShell, ShellResult } from './host-shell.js'
import {
  createK3sClusterDependency,
  K3sWedgedError,
  looksLikeCgroupWedge,
} from './supervise-k3s.js'
import { OperatorActionRequiredError } from './supervise-runtime.js'

const RUNC_WEDGE =
  'failed to create task for container: failed to create shim task: OCI runtime create failed: ' +
  'runc create failed: unable to start container process: unable to apply cgroup configuration: ' +
  'failed to write 1389: write /sys/fs/cgroup/docker/0651b506/cgroup.procs: device or resource busy'

/** A shell whose answers are scripted per `cmd argv[0] argv[1]` prefix, with a call log. */
function fakeShell(routes: Record<string, Partial<ShellResult>>): HostShell & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    run(cmd, args) {
      const line = [cmd, ...args].join(' ')
      calls.push(line)
      const key = Object.keys(routes).find((prefix) => line.startsWith(prefix))
      const hit = key ? routes[key] : undefined
      return Promise.resolve({
        code: hit?.code ?? 1,
        stdout: hit?.stdout ?? '',
        stderr: hit?.stderr ?? '',
      })
    },
  }
}

const REACHABLE = JSON.stringify({
  clientVersion: { gitVersion: 'v1.36.1' },
  serverVersion: { gitVersion: 'v1.30.6+k3s1' },
})
/** kubectl still prints the client half when the apiserver is down — the shape that fooled a naive check. */
const UNREACHABLE = JSON.stringify({ clientVersion: { gitVersion: 'v1.36.1' } })

describe('looksLikeCgroupWedge', () => {
  it('recognises the real runc failure', () => {
    expect(looksLikeCgroupWedge(RUNC_WEDGE)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(looksLikeCgroupWedge('Device Or Resource Busy')).toBe(true)
  })

  it('does not fire on an ordinary start failure', () => {
    expect(looksLikeCgroupWedge('Error: no such cluster "cat-factory"')).toBe(false)
  })
})

describe('createK3sClusterDependency', () => {
  it('is ready without touching the cluster when the apiserver answers', async () => {
    const shell = fakeShell({ 'kubectl version': { code: 0, stdout: REACHABLE } })
    const dependency = createK3sClusterDependency(shell, {
      cluster: 'cat-factory',
      runtime: 'k3d',
    })

    await expect(dependency.ensure()).resolves.toBe(true)
    // No start attempt: a healthy cluster must never be disturbed.
    expect(shell.calls.some((c) => c.includes('cluster start'))).toBe(false)
  })

  it('judges reachability from the apiserver half, not the exit code', async () => {
    // Down apiserver: kubectl exits non-zero but still emits clientVersion.
    const shell = fakeShell({
      'kubectl version': { code: 1, stdout: UNREACHABLE },
      'k3d cluster list': { code: 0, stdout: JSON.stringify([{ name: 'cat-factory' }]) },
      'k3d cluster start': { code: 0, stdout: 'started' },
    })
    const dependency = createK3sClusterDependency(shell, {
      cluster: 'cat-factory',
      runtime: 'k3d',
      readyTimeoutMs: 30,
      readyPollMs: 5,
    })

    // Never becomes reachable, so it gives up rather than hanging — retried next cycle.
    await expect(dependency.ensure()).resolves.toBe(false)
    expect(shell.calls).toContain('k3d cluster start cat-factory')
  })

  it('starts a cluster that exists but is stopped, then reports ready', async () => {
    let started = false
    const shell: HostShell = {
      run(cmd, args) {
        const line = [cmd, ...args].join(' ')
        if (line.startsWith('kubectl version')) {
          return Promise.resolve({
            code: started ? 0 : 1,
            stdout: started ? REACHABLE : UNREACHABLE,
            stderr: '',
          })
        }
        if (line.startsWith('k3d cluster list')) {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify([{ name: 'cat-factory' }]),
            stderr: '',
          })
        }
        if (line.startsWith('k3d cluster start')) {
          started = true
          return Promise.resolve({ code: 0, stdout: 'started', stderr: '' })
        }
        return Promise.resolve({ code: 1, stdout: '', stderr: '' })
      },
    }

    const dependency = createK3sClusterDependency(shell, {
      cluster: 'cat-factory',
      runtime: 'k3d',
    })
    await expect(dependency.ensure()).resolves.toBe(true)
  })

  it('refuses to create a cluster that does not exist', async () => {
    const shell = fakeShell({
      'kubectl version': { code: 1, stdout: UNREACHABLE },
      'k3d cluster list': { code: 0, stdout: '[]' },
    })
    const dependency = createK3sClusterDependency(shell, { cluster: 'gone', runtime: 'k3d' })

    await expect(dependency.ensure()).resolves.toBe(false)
    // Provisioning owns RBAC + a service account; `cat-factory k3s` is the deliberate path.
    expect(shell.calls.some((c) => c.includes('cluster create'))).toBe(false)
  })

  it('raises an operator-action error on the cgroup wedge instead of retrying it', async () => {
    const shell = fakeShell({
      'kubectl version': { code: 1, stdout: UNREACHABLE },
      'k3d cluster list': { code: 0, stdout: JSON.stringify([{ name: 'cat-factory' }]) },
      'k3d cluster start': { code: 1, stderr: RUNC_WEDGE },
    })
    const dependency = createK3sClusterDependency(shell, {
      cluster: 'cat-factory',
      runtime: 'k3d',
    })

    await expect(dependency.ensure()).rejects.toThrow(K3sWedgedError)
    // The loop dedupes on this base type, so the inheritance is load-bearing.
    await expect(dependency.ensure()).rejects.toThrow(OperatorActionRequiredError)
    await expect(dependency.ensure()).rejects.toThrow(/restart the container engine/i)
  })

  it('starts a kind cluster by its control-plane container', async () => {
    let started = false
    const shell: HostShell = {
      run(cmd, args) {
        const line = [cmd, ...args].join(' ')
        if (line.startsWith('kubectl version')) {
          return Promise.resolve({
            code: started ? 0 : 1,
            stdout: started ? REACHABLE : UNREACHABLE,
            stderr: '',
          })
        }
        if (line.startsWith('kind get clusters')) {
          return Promise.resolve({ code: 0, stdout: 'cat-factory\n', stderr: '' })
        }
        if (line === 'docker start cat-factory-control-plane') {
          started = true
          return Promise.resolve({ code: 0, stdout: '', stderr: '' })
        }
        return Promise.resolve({ code: 1, stdout: '', stderr: '' })
      },
    }

    const dependency = createK3sClusterDependency(shell, {
      cluster: 'cat-factory',
      runtime: 'kind',
    })
    await expect(dependency.ensure()).resolves.toBe(true)
  })
})
