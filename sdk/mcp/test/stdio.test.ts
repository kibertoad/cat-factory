import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { describe, expect, it } from 'vitest'
import { ENV_VARS } from '../src/config.ts'
import { bootStdioServer, startupFailureMessage } from '../src/stdio.ts'

// The executable's own rules, driven without a subprocess: what it writes and where, in what order,
// and what it does when the configuration is wrong. `bin.ts` is the process wiring around this and
// nothing else, and the real binary is driven end to end by `backend/internal/sdk-smoketest`.

const ENV = {
  [ENV_VARS.baseUrl]: 'https://cat-factory.test',
  [ENV_VARS.apiKey]: 'cf_live_key.secret',
}

/** A boot that records what it logged and what it connected, in order. */
function recording() {
  const log: string[] = []
  const events: string[] = []
  return {
    log,
    events,
    deps: {
      log: (line: string) => {
        log.push(line)
        events.push('log')
      },
      connect: async (_server: Server) => {
        events.push('connect')
      },
    },
  }
}

describe('bootStdioServer', () => {
  it('connects the transport BEFORE announcing that it is ready', async () => {
    const { log, events, deps } = recording()
    const result = await bootStdioServer({ env: ENV, ...deps })

    // Announcing first would put a line claiming success in the host's log next to a server that
    // then failed to connect and never served anything.
    expect(events).toEqual(['connect', 'log'])
    expect(result.toolCount).toBeGreaterThan(0)
    expect(log.join('')).toContain(`${result.toolCount} tools`)
    expect(log.join('')).toContain('https://cat-factory.test')
  })

  it('writes every human-readable byte through the injected sink', async () => {
    // STDOUT IS THE PROTOCOL: a banner on stdout corrupts the JSON-RPC stream and the host reports a
    // server that connected and then broke. `log` is the only sink this module has, which is what
    // makes the rule checkable at all.
    const { log, deps } = recording()
    await bootStdioServer({ env: ENV, ...deps })
    expect(log).toHaveLength(1)
    expect(log[0]!.endsWith('\n')).toBe(true)
  })

  it('reads the key from a file when the host config names one', async () => {
    const { log, deps } = recording()
    await bootStdioServer({
      env: {
        [ENV_VARS.baseUrl]: 'https://cat-factory.test',
        [ENV_VARS.apiKeyFile]: '/run/secrets/cat-factory',
      },
      readSecretFile: () => 'cf_live_key.secret\n',
      ...deps,
    })
    // The key never appears in what the process says about itself, on any path.
    expect(log.join('')).not.toContain('cf_live_key')
  })

  it('rejects rather than starting a server that cannot work', async () => {
    const { events, deps } = recording()
    await expect(bootStdioServer({ env: {}, ...deps })).rejects.toThrow(ENV_VARS.baseUrl)
    // Nothing was connected, so the host reports a server that failed to start rather than one that
    // is up and refuses every call.
    expect(events).toEqual([])
  })

  it('names the configuration in the failure the executable prints', () => {
    const message = startupFailureMessage(new Error('CAT_FACTORY_BASE_URL is required'))
    expect(message).toContain('failed to start')
    expect(message).toContain(ENV_VARS.baseUrl)
    // Both ways of supplying the key, so an operator reading this in a host's log knows the file
    // option exists without going to the README.
    expect(message).toContain(ENV_VARS.apiKey)
    expect(message).toContain(ENV_VARS.apiKeyFile)
    // A non-Error rejection still says something rather than `[object Object]`.
    expect(startupFailureMessage('plain string')).toContain('plain string')
  })
})
