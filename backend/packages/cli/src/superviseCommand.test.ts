import { describe, expect, it } from 'vitest'
import { ArgError, type CliOptions } from './args.js'
import { quoteToken, supervise, timestamp } from './superviseCommand.js'

const WINDOWS_NODE = 'C:\\Program Files\\nodejs\\node.exe'

function opts(extra: Partial<CliOptions>): CliOptions {
  return { command: 'supervise', noOpen: false, yes: false, force: false, ...extra }
}

describe('quoteToken', () => {
  it('leaves a plain token alone', () => {
    expect(quoteToken('pnpm')).toBe('pnpm')
    expect(quoteToken('dev:raw')).toBe('dev:raw')
    expect(quoteToken('--watch')).toBe('--watch')
  })

  it('quotes a Windows path containing a space WITHOUT escaping its backslashes', () => {
    const quoted = quoteToken(WINDOWS_NODE, 'win32')
    expect(quoted).toBe(`"${WINDOWS_NODE}"`)
    // The bug this guards: `JSON.stringify` would double every separator
    // ("C:\\\\Program Files\\\\…"), and no shell unescapes those — so the quoted path resolves to a
    // path that does not exist, and the supervised command dies instantly with "cannot find module".
    expect(quoted).not.toContain('\\\\')
    expect(quoted.slice(1, -1)).toBe(WINDOWS_NODE)
  })

  it('preserves a POSIX path with a space', () => {
    expect(quoteToken('/home/me/my projects/app.mjs', 'linux')).toBe(
      '"/home/me/my projects/app.mjs"',
    )
  })

  // An embedded quote needs a DIFFERENT escape per shell, and `shell: true` really does hand the
  // string to a different one on each platform. cmd.exe honours no backslash escape at all — it
  // would pass the backslash through and read the quote as closing the argument — so a single
  // POSIX-shaped rule silently mangles the command on exactly one of the two hosts.
  it('escapes an embedded double quote the POSIX way', () => {
    expect(quoteToken('say "hi"', 'linux')).toBe('"say \\"hi\\""')
  })

  it('escapes an embedded double quote the cmd.exe way, by doubling it', () => {
    expect(quoteToken('say "hi"', 'win32')).toBe('"say ""hi"""')
  })

  it('defaults to the host platform', () => {
    expect(quoteToken('say "hi"')).toBe(quoteToken('say "hi"', process.platform))
  })

  it('renders an empty token as an explicit empty argument', () => {
    expect(quoteToken('')).toBe('""')
  })
})

describe('supervise — argument refusals', () => {
  it('needs a command after `--`', async () => {
    await expect(supervise(opts({}))).rejects.toThrow(ArgError)
  })

  it('REFUSES --runtime k3s rather than silently supervising it as k3d', async () => {
    // Degrading quietly would leave `k3d cluster list` never listing the cluster, so the dependency
    // reported "not ready — will retry next cycle" forever with nothing naming the real reason.
    // This throws before anything is spawned, which is what keeps the test cheap.
    await expect(
      supervise(opts({ superviseCommand: ['true'], k3sCluster: 'c', k3sRuntime: 'k3s' })),
    ).rejects.toThrow(/cannot be supervised/)
  })
})

describe('timestamp', () => {
  it('renders zero-padded local wall-clock time', () => {
    // Constructed via local-time components, since the helper reads local getters by design.
    expect(timestamp(new Date(2026, 7, 25, 9, 5, 3))).toBe('09:05:03')
    expect(timestamp(new Date(2026, 7, 25, 23, 59, 59))).toBe('23:59:59')
  })
})
