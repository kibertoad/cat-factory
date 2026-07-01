import { describe, expect, it } from 'vitest'
import { type CliOptions } from './args.js'
import { COMMAND_NOT_FOUND, type HostShell, type ShellResult } from './host-shell.js'
import { type Io } from './io.js'
import { K3S_INSTALL_COMMAND, setupK3s } from './k3s.js'

/** A fake shell keyed by `` `${cmd} ${args.join(' ')}` ``; unmapped ⇒ command-not-found. */
function scriptShell(map: Record<string, Partial<ShellResult>> = {}): HostShell {
  return {
    run(cmd, args) {
      const hit = map[[cmd, ...args].join(' ')]
      return Promise.resolve<ShellResult>(
        hit
          ? { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
          : { code: COMMAND_NOT_FOUND, stdout: '', stderr: 'not found' },
      )
    },
  }
}

/** Scripted Io that records every info line and returns queued selects. */
function captureIo(selects: string[] = []): Io & { lines: string[] } {
  const lines: string[] = []
  const sel = [...selects]
  return {
    lines,
    info: (m) => {
      lines.push(m)
    },
    warn: (m) => {
      lines.push(m)
    },
    question: (_p, d) => Promise.resolve(d ?? ''),
    select: <T extends string>(_p: string, _o: readonly { value: T }[], d: T) =>
      Promise.resolve((sel.shift() as T | undefined) ?? d),
    secret: () => Promise.resolve(''),
    confirm: (_p, d) => Promise.resolve(d),
    openBrowser: () => Promise.resolve(),
  }
}

function opts(extra: Partial<CliOptions>): CliOptions {
  return { command: 'k3s', noOpen: false, yes: false, force: false, ...extra }
}

const REACHABLE = {
  'kubectl version --output=json': {
    code: 0,
    stdout: JSON.stringify({ serverVersion: { gitVersion: 'v1.30.0' } }),
  },
  'kubectl config current-context': { code: 0, stdout: 'k3d-cat-factory' },
}

describe('setupK3s', () => {
  it('in --yes mode picks the recommended offer (reuse existing cluster)', async () => {
    const io = captureIo()
    const { state, chosen } = await setupK3s(opts({ yes: true }), {
      io,
      shell: scriptShell(REACHABLE),
    })
    expect(state.detections.reachableCluster).toBe(true)
    expect(chosen).toBe('use-existing')
    expect(io.lines.join('\n')).toContain('reachable cluster')
  })

  it('prints the k3s install command (never runs it) when nothing usable is present', async () => {
    const io = captureIo()
    const { chosen } = await setupK3s(opts({ yes: true }), { io, shell: scriptShell({}) })
    expect(chosen).toBe('install-k3s')
    const out = io.lines.join('\n')
    expect(out).toContain(K3S_INSTALL_COMMAND)
    expect(out).toContain('needs sudo')
  })

  it('honors an interactive selection over the recommendation', async () => {
    // Reachable cluster ⇒ recommended is use-existing; user instead picks install-k3s.
    const io = captureIo(['install-k3s'])
    const { chosen } = await setupK3s(opts({}), { io, shell: scriptShell(REACHABLE) })
    expect(chosen).toBe('install-k3s')
  })

  it('reports the findings and does not mutate the host', async () => {
    const io = captureIo()
    await setupK3s(opts({ yes: true }), { io, shell: scriptShell(REACHABLE) })
    const out = io.lines.join('\n')
    expect(out).toContain('Detected:')
    expect(out).toContain('nothing was changed on your host')
  })

  it('echoes the chosen cluster name for the k3d path', async () => {
    const shell = scriptShell({
      'k3d version': { code: 0, stdout: 'k3d version v5.6.0' },
      'docker version --format {{.Server.Version}}': { code: 0, stdout: '27.0.0' },
    })
    const io = captureIo()
    const { chosen } = await setupK3s(opts({ yes: true, clusterName: 'my-cluster' }), { io, shell })
    expect(chosen).toBe('create-k3d')
    expect(io.lines.join('\n')).toContain('my-cluster')
  })
})
