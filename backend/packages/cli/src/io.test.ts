import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildK3sSetupUrl } from './k3s-handler.js'
import { createConsoleIo, openCommand, type OpenBrowserCommand } from './io.js'
import { patCreationUrl } from './vcs.js'

/** The real `cat-factory k3s` hand-off link: the multi-parameter URL the bug truncated. */
const DEEP_LINK = buildK3sSetupUrl('http://localhost:3000', {
  engine: 'local-k3s',
  clusterName: 'cat-factory',
  runtime: 'k3d',
  apiServerUrl: 'https://127.0.0.1:6443',
  apiToken: 'tok-abc',
  insecureSkipTlsVerify: true,
  ingress: {
    status: 'ready',
    port: 80,
    controller: 'traefik.io/ingress-controller',
    attribution: 'cluster',
  },
})

/** The command line `windowsVerbatimArguments` hands to `CreateProcess`: the argv joined, as-is. */
function verbatimCommandLine({ cmd, args }: OpenBrowserCommand): string {
  return [cmd, ...args].join(' ')
}

/**
 * The one cmd rule this fix rests on: a command separator or redirection is literal INSIDE double
 * quotes and splits the line outside them. Returns the characters cmd would still act on, so an
 * assertion can be about what the shell does with our command line rather than about the string we
 * just built. The pre-fix argv fails it on the URL's own `&`.
 */
function metacharactersCmdWouldActOn(commandLine: string): string[] {
  const live: string[] = []
  let quoted = false
  for (const char of commandLine) {
    if (char === '"') quoted = !quoted
    else if (!quoted && '&|<>'.includes(char)) live.push(char)
  }
  // An unbalanced quote leaves the rest of the line in a state cmd parses differently than this
  // scan did, so it is a failure of the same property.
  if (quoted) live.push('"')
  return live
}

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

  it('leaves cmd nothing to split a Windows deep-link on', () => {
    // The regression this pins: cmd splits an unquoted line on `&`, so the browser used to receive
    // only the parameters before the first one and cmd tried to run the rest.
    const line = verbatimCommandLine(openCommand(DEEP_LINK, 'win32'))

    expect(line).toContain('&') // Otherwise there is nothing here for the quoting to save.
    expect(metacharactersCmdWouldActOn(line)).toEqual([])
  })

  it('quotes the multi-parameter PAT creation links too', () => {
    // Same shell, same trap: an unquoted GitHub link dropped its `scopes` parameter, leaving the
    // developer to re-pick the scopes the URL exists to preselect.
    for (const url of [patCreationUrl('github'), patCreationUrl('gitlab')]) {
      expect(url).toContain('&')
      expect(metacharactersCmdWouldActOn(verbatimCommandLine(openCommand(url, 'win32')))).toEqual(
        [],
      )
    }
  })

  it('serializes a URL carrying a quote instead of letting it close the quoting', () => {
    // No caller builds a link this way today; the point is that none CAN, because the quoting is
    // safe by construction rather than by convention. Unserialized, this closes the URL argument
    // and leaves cmd a `&` to run `calc` on.
    const hostile = 'https://example.com/setup?name=" & calc & "x'

    const { args } = openCommand(hostile, 'win32')

    expect(args.at(-1)).toBe(`"${new URL(hostile).href}"`)
    expect(args.at(-1)).not.toContain('" ')
    expect(metacharactersCmdWouldActOn(verbatimCommandLine(openCommand(hostile, 'win32')))).toEqual(
      [],
    )
  })

  it('refuses input that is not a URL rather than handing cmd an unchecked line', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(() => openCommand('example.com & calc', platform)).toThrow(TypeError)
    }
  })

  it('keeps openBrowser best-effort when the URL is refused', async () => {
    // The refusal is a programmer error, and the call sites print the link before opening it, so
    // the browser hand-off must still resolve instead of taking the CLI down mid-flow.
    await expect(createConsoleIo().openBrowser('example.com & calc')).resolves.toBeUndefined()
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
