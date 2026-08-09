import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildK3sHandler, buildK3sSetupUrl } from './k3s-handler.js'
import { openCommand } from './io.js'
import { patCreationUrl } from './vcs.js'

/** The real `cat-factory k3s` hand-off link: the multi-parameter URL the bug truncated. */
const DEEP_LINK = buildK3sSetupUrl(
  'http://localhost:3000',
  buildK3sHandler({
    engine: 'local-k3s',
    clusterName: 'cat-factory',
    apiServerUrl: 'https://127.0.0.1:6443',
    apiToken: 'tok-abc',
    insecureSkipTlsVerify: true,
  }),
)

describe('openCommand', () => {
  it('hands the URL to the platform opener as a single argument on macOS and Linux', () => {
    expect(openCommand(DEEP_LINK, 'darwin')).toEqual({ cmd: 'open', args: [DEEP_LINK] })
    expect(openCommand(DEEP_LINK, 'linux')).toEqual({ cmd: 'xdg-open', args: [DEEP_LINK] })
  })

  it('quotes the URL for cmd on Windows so its query survives the shell', () => {
    const { cmd, args, windowsVerbatimArguments } = openCommand(DEEP_LINK, 'win32')

    expect(cmd).toBe('cmd')
    // The quoting is only honoured if the argv reaches CreateProcess unchanged.
    expect(windowsVerbatimArguments).toBe(true)
    // `start` reads a leading quoted token as the window title, so the URL needs one ahead of it.
    expect(args.slice(0, 3)).toEqual(['/c', 'start', '""'])
    expect(args.at(-1)).toBe(`"${DEEP_LINK}"`)
  })

  it('leaves every query parameter of a Windows deep-link intact', () => {
    // The regression this pins: cmd splits an unquoted line on `&`, so the browser used to receive
    // only the parameters before the first one. Assert against the link's OWN parameters rather
    // than a hand-copied list, so a new prefill field is covered without editing this test.
    const quoted = openCommand(DEEP_LINK, 'win32').args.at(-1) ?? ''
    const opened = new URL(quoted.slice(1, -1))

    expect([...opened.searchParams]).toEqual([...new URL(DEEP_LINK).searchParams])
    expect(opened.searchParams.get('apiServerUrl')).toBe('https://127.0.0.1:6443')
  })

  it('quotes the multi-parameter PAT creation links too', () => {
    // Same shell, same trap: an unquoted GitHub link dropped its `scopes` parameter, leaving the
    // developer to re-pick the scopes the URL exists to preselect.
    for (const url of [patCreationUrl('github'), patCreationUrl('gitlab')]) {
      expect(url).toContain('&')
      expect(openCommand(url, 'win32').args.at(-1)).toBe(`"${url}"`)
    }
  })
})

// Only a real cmd can show that its parser accepts what we build; the assertions above pin the
// shape, not the shell. `echo` stands in for the `start` builtin: the bug was in how cmd SPLIT the
// command line, one step before `start` ran at all.
describe.skipIf(process.platform !== 'win32')('openCommand on a real cmd', () => {
  it('passes the whole URL through as one argument', () => {
    const { cmd, args, windowsVerbatimArguments } = openCommand(DEEP_LINK, 'win32')
    const result = spawnSync(
      cmd,
      args.map((arg) => (arg === 'start' ? 'echo' : arg)),
      { encoding: 'utf8', windowsVerbatimArguments },
    )

    expect(result.stdout.trim()).toBe(`"" "${DEEP_LINK}"`)
    // Anything cmd split off would surface here as an unrecognised command.
    expect(result.stderr).toBe('')
  })
})
