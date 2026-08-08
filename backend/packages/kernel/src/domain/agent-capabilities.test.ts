import { describe, expect, it } from 'vitest'
import type { HarnessKind } from '../ports/model-provider.js'
import type { McpServerDefinition } from './agent-capabilities.js'
import {
  MCP_HARNESS_TRANSPORTS,
  MCP_SUPPORTED_HARNESSES,
  TOOL_SERVER_BUDGET,
  isAllowedMcpHttpUrl,
  isLoopbackMcpHttpUrl,
  isValidMcpServerId,
  isValidMcpToolName,
  mcpHarnessServesTransport,
  mcpServableHarnesses,
  mcpServerSupportsHarness,
  toolServerDeclaredBytes,
} from './agent-capabilities.js'

// The pure rules deciding whether a declared tool server can run at all. They exist here, in
// kernel, because THREE layers must agree about the answer: the dispatch (which drops a server it
// cannot serve, with a stated reason), boot validation (which warns about a combination no run could
// ever serve), and the harness (which writes each CLI's config).

const HARNESSES: HarnessKind[] = ['pi', 'claude-code', 'codex']

function server(over: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    id: 'issues',
    transport: { kind: 'stdio', command: 'npx' },
    ...over,
  }
}

const httpServer = (over: Partial<McpServerDefinition> = {}): McpServerDefinition =>
  server({ transport: { kind: 'http', url: 'https://mcp.example.com/mcp' }, ...over })

describe('MCP_HARNESS_TRANSPORTS', () => {
  it('answers for EVERY harness, so a new one cannot silently mean "no tool servers"', () => {
    for (const harness of HARNESSES) {
      expect(MCP_HARNESS_TRANSPORTS[harness], harness).toBeDefined()
    }
  })

  it('states the two facts the whole slice turns on', () => {
    // Pi has no MCP client; Codex's is stdio-only. Everything else here derives from these.
    expect(MCP_HARNESS_TRANSPORTS.pi).toEqual([])
    expect(MCP_HARNESS_TRANSPORTS.codex).toEqual(['stdio'])
    expect(MCP_HARNESS_TRANSPORTS['claude-code']).toEqual(['stdio', 'http'])
  })

  it('derives MCP_SUPPORTED_HARNESSES, so the two cannot drift into disagreeing', () => {
    expect(MCP_SUPPORTED_HARNESSES).toEqual(['claude-code', 'codex'])
    for (const harness of HARNESSES) {
      expect(MCP_SUPPORTED_HARNESSES.includes(harness), harness).toBe(
        MCP_HARNESS_TRANSPORTS[harness].length > 0,
      )
    }
  })
})

describe('mcpHarnessServesTransport', () => {
  it('refuses http on codex — the defect this rule was added for', () => {
    // Before this, `servableOnThisRun` checked harness membership only: an http server was
    // advertised in a Codex run's prompt ("prefer them over guessing") and then skipped by the
    // harness's stdio-only TOML writer, so the agent planned around a tool it never had.
    expect(mcpHarnessServesTransport('codex', 'http')).toBe(false)
    expect(mcpHarnessServesTransport('codex', 'stdio')).toBe(true)
    expect(mcpHarnessServesTransport('claude-code', 'http')).toBe(true)
  })

  it('refuses everything on pi, which has no MCP client', () => {
    expect(mcpHarnessServesTransport('pi', 'stdio')).toBe(false)
    expect(mcpHarnessServesTransport('pi', 'http')).toBe(false)
  })
})

describe('mcpServerSupportsHarness', () => {
  it('defaults to every MCP-speaking harness and lets a definition NARROW it', () => {
    expect(mcpServerSupportsHarness(server(), 'claude-code')).toBe(true)
    expect(mcpServerSupportsHarness(server(), 'codex')).toBe(true)
    expect(mcpServerSupportsHarness(server({ harnesses: ['claude-code'] }), 'codex')).toBe(false)
  })

  it('cannot be WIDENED onto a harness with no MCP client', () => {
    // A registration cannot teach Pi an MCP client, so naming it is inert rather than enabling.
    expect(mcpServerSupportsHarness(server({ harnesses: ['pi'] }), 'pi')).toBe(false)
  })
})

describe('mcpServableHarnesses', () => {
  it('intersects the declared allow-list with the harnesses that reach the transport', () => {
    expect(mcpServableHarnesses(server())).toEqual(['claude-code', 'codex'])
    // An http server is claude-code only, WITHOUT the definition having to say so.
    expect(mcpServableHarnesses(httpServer())).toEqual(['claude-code'])
    expect(mcpServableHarnesses(server({ harnesses: ['codex'] }))).toEqual(['codex'])
  })

  it('is EMPTY exactly for the combinations no run could ever serve', () => {
    // This is the boot-warning trigger: nothing is ever dropped for a reason here, because the
    // server simply never applies — so no prompt and no log line would ever mention it.
    expect(mcpServableHarnesses(httpServer({ harnesses: ['codex'] }))).toEqual([])
    expect(mcpServableHarnesses(server({ harnesses: ['pi'] }))).toEqual([])
    expect(mcpServableHarnesses(server({ harnesses: [] }))).toEqual([])
  })
})

// The measure boot validation warns on. It exists because the dispatch measures the RESOLVED spec,
// which nothing before a run can see, and "no measure at all" is what left the byte half of the
// budget with no declaration-time channel while the count half had one.
describe('toolServerDeclaredBytes', () => {
  it('counts the transport config, so a fat env block is visible before any run', () => {
    const lean = toolServerDeclaredBytes(server())
    const fat = toolServerDeclaredBytes(
      server({ transport: { kind: 'stdio', command: 'npx', env: { BLOB: 'x'.repeat(5_000) } } }),
    )
    expect(lean).toBeLessThan(200)
    expect(fat).toBeGreaterThan(5_000)
  })

  it('is a FLOOR: it ignores what stays behind and what a dispatch only adds', () => {
    // `label` / `guidance` go to the prompt and `secretKeys` becomes resolved VALUES, which only
    // grow the body. Counting the first two would let boot warn about a payload no dispatch sends.
    const bare = toolServerDeclaredBytes(server())
    const decorated = toolServerDeclaredBytes(
      server({
        label: 'Issue tracker',
        guidance: 'Look up an issue before guessing at its intent.',
        secretKeys: [{ key: 'ISSUE_TOKEN' }],
      }),
    )
    expect(decorated).toBe(bare)
  })

  it('counts BYTES, not UTF-16 units, so a non-ASCII config value is not undercounted', () => {
    // Kernel compiles against neither DOM nor Node types, so this is a hand-counted UTF-8 length.
    // `string.length` would read a CJK env value as a third of its real size, which would break the
    // floor the boot warning depends on.
    const ascii = toolServerDeclaredBytes(
      server({ transport: { kind: 'stdio', command: 'npx', env: { NOTE: 'aaa' } } }),
    )
    const cjk = toolServerDeclaredBytes(
      server({ transport: { kind: 'stdio', command: 'npx', env: { NOTE: '課題管理' } } }),
    )
    // Four 3-byte characters where the ASCII case had three 1-byte ones.
    expect(cjk - ascii).toBe(9)
  })

  it('measures an http server by its url and headers', () => {
    expect(toolServerDeclaredBytes(httpServer())).toBeGreaterThan(0)
    expect(
      toolServerDeclaredBytes(
        httpServer({ transport: { kind: 'http', url: 'https://mcp.example.com/mcp' } }),
      ),
    ).toBeLessThan(TOOL_SERVER_BUDGET.maxTotalBytes)
  })

  it('counts the HTTP transport fields, not just the stdio ones', () => {
    // The two transports contribute different fields, so the measure has to branch on the kind.
    // Counting the stdio shape for an http server would report a fat header block as ~nothing,
    // which is the one direction a FLOOR may not be wrong in.
    const lean = toolServerDeclaredBytes(httpServer())
    const longUrl = toolServerDeclaredBytes(
      httpServer({
        transport: { kind: 'http', url: `https://mcp.example.com/mcp${'x'.repeat(40)}` },
      }),
    )
    expect(longUrl - lean).toBe(40)
    const withHeaders = toolServerDeclaredBytes(
      httpServer({
        transport: {
          kind: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { A: 'y'.repeat(500) },
        },
      }),
    )
    expect(withHeaders - lean).toBeGreaterThan(500)
  })

  it('counts each UTF-8 width class at its exact boundary', () => {
    // The widths are picked by three chained comparisons, and every one of them is a boundary the
    // budget is wrong at if it is off by one: `<= 0x7f` rather than `<`, and so on up. Measured as
    // deltas against a one-byte value so the surrounding JSON cancels out.
    const bytesFor = (value: string) =>
      toolServerDeclaredBytes(
        server({ transport: { kind: 'stdio', command: 'npx', env: { V: value } } }),
      )
    const oneByte = bytesFor('a')
    expect(bytesFor('\u007f') - oneByte).toBe(0) // last 1-byte code point
    expect(bytesFor('\u0080') - oneByte).toBe(1) // first 2-byte
    expect(bytesFor('\u07ff') - oneByte).toBe(1) // last 2-byte
    expect(bytesFor('\u0800') - oneByte).toBe(2) // first 3-byte
    expect(bytesFor('\uffff') - oneByte).toBe(2) // last 3-byte
    // A code point above the BMP is FOUR bytes and ONE character: walking UTF-16 units instead
    // would see two 3-byte characters and overcount it by two.
    expect(bytesFor('\u{10000}') - oneByte).toBe(3)
  })
})

describe('isValidMcpServerId', () => {
  it('accepts the ids that survive both a tool-name prefix and a TOML table key', () => {
    for (const good of ['issues', 'issue-tracker', 'issue_tracker', 'v2', '0']) {
      expect(isValidMcpServerId(good), good).toBe(true)
    }
  })

  it('refuses anything that would break `mcp__<id>__<tool>` or the Codex TOML key', () => {
    // Each of these fails deep inside the CLI rather than at registration: a dot or a quote
    // malforms the TOML table key, an uppercase letter or a space produces an allow-list entry no
    // tool name ever matches.
    for (const bad of [
      'Issues',
      'issue.tracker',
      'issue tracker',
      'issue"s',
      '-issues',
      '_issues',
      '',
    ]) {
      expect(isValidMcpServerId(bad), bad).toBe(false)
    }
  })

  it('bounds the length at 64 characters', () => {
    expect(isValidMcpServerId('a'.repeat(64))).toBe(true)
    expect(isValidMcpServerId('a'.repeat(65))).toBe(false)
  })
})

// The cleartext rule for an HTTP tool server. An http server routinely carries a resolved
// credential in a request header, so "is this host loopback" decides whether that credential goes
// on the wire in the clear, which is why it is worth pinning host by host rather than through one
// happy-path url.
//
// Several of these state the ANSWER beside the reason it is the answer: what the request actually
// resolves to. That is the property the rule exists for, and asserting a verdict without it is how
// a spoof nobody thought of passes a hand-written table (the case below with a backslash in it did
// exactly that). Reached through `globalThis` because the kernel compiles against the ES2022 lib,
// the same way the module under test reaches it.
const RequestUrl = (globalThis as { URL?: new (url: string) => { hostname: string } }).URL!

describe('isAllowedMcpHttpUrl', () => {
  it('allows https anywhere', () => {
    expect(isAllowedMcpHttpUrl('https://mcp.example.com/mcp')).toBe(true)
  })

  it('allows cleartext http ONLY on loopback', () => {
    expect(isAllowedMcpHttpUrl('http://127.0.0.1:8080/mcp')).toBe(true)
    expect(isAllowedMcpHttpUrl('http://localhost:8080/mcp')).toBe(true)
    expect(isAllowedMcpHttpUrl('http://[::1]:8080/mcp')).toBe(true)
    expect(isAllowedMcpHttpUrl('http://mcp.example.com/mcp')).toBe(false)
  })

  it('treats the whole 127.0.0.0/8 range as loopback, and nothing that merely resembles it', () => {
    expect(isAllowedMcpHttpUrl('http://127.0.0.1')).toBe(true)
    expect(isAllowedMcpHttpUrl('http://127.255.255.255')).toBe(true)
    for (const notLoopback of [
      'http://a127.0.0.1', // the range is anchored at the start of the host
      'http://127.0.0.1.evil.example', // ... and at its end
      'http://127x0x0x1', // the dots are literal, not any-character
      'http://128.0.0.1',
    ]) {
      expect(isAllowedMcpHttpUrl(notLoopback), notLoopback).toBe(false)
    }
  })

  it('reads the host case-insensitively, scheme included', () => {
    expect(isAllowedMcpHttpUrl('HTTP://LOCALHOST:8080')).toBe(true)
    expect(isAllowedMcpHttpUrl('HTTPS://MCP.EXAMPLE.COM')).toBe(true)
  })

  it('strips userinfo from the LAST @, so a loopback-looking user is not a loopback host', () => {
    // The trap the userinfo rule exists for: `http://127.0.0.1@evil.example` sends the request
    // (and its credential header) to evil.example while reading as loopback to anything that
    // splits on the FIRST @.
    expect(isAllowedMcpHttpUrl('http://127.0.0.1@evil.example')).toBe(false)
    expect(isAllowedMcpHttpUrl('http://localhost@evil.example/mcp')).toBe(false)
    expect(isAllowedMcpHttpUrl('http://user@127.0.0.1:8080')).toBe(true)
    // Userinfo may itself contain an `@`, so the host is what follows the last one.
    expect(isAllowedMcpHttpUrl('http://user@evil.example@127.0.0.1')).toBe(true)
  })

  it('ends the host at every delimiter the REQUEST does, backslash included', () => {
    // The property that makes this predicate mean anything: the host it rules on is the host the
    // credential header actually travels to. A backslash terminates the authority of a special
    // scheme exactly as `/` does, so `fetch` sends these to evil.example with `@127.0.0.1` sitting
    // in the PATH, while an authority scan that stops only at `/?#` swallows the delimiter, finds
    // a last `@` that is not a userinfo separator at all, and hands evil.example a cleartext
    // credential. Pinned beside the `/?#` spoofs it is indistinguishable from.
    for (const spoof of [
      'http://evil.example/@127.0.0.1',
      'http://evil.example?next=@127.0.0.1',
      'http://evil.example#@127.0.0.1',
      'http://evil.example\\@127.0.0.1/mcp',
      'http://evil.example\\@localhost',
    ]) {
      expect(isAllowedMcpHttpUrl(spoof), spoof).toBe(false)
      expect(new RequestUrl(spoof).hostname, `${spoof} really reaches`).toBe('evil.example')
    }
  })

  it('grants the exemption to every spelling of loopback the request resolves to one', () => {
    // The same property read the other way, and the direction a hand-written parse got wrong
    // silently: these are all `127.0.0.1` to the URL parser the agent CLI dials with, so refusing
    // them would refuse a server genuinely running beside the agent. `isLoopbackMcpHttpUrl` reads
    // the same answer, which is what keeps the operability probe off the BACKEND's own loopback.
    for (const shorthand of ['http://127.1', 'http://0177.0.0.1', 'http://2130706433/mcp']) {
      expect(new RequestUrl(shorthand).hostname, `${shorthand} really reaches`).toBe('127.0.0.1')
      expect(isAllowedMcpHttpUrl(shorthand), shorthand).toBe(true)
      expect(isLoopbackMcpHttpUrl(shorthand), shorthand).toBe(true)
    }
    // ... and the uncompressed IPv6 loopback, which the parser compresses to `::1`.
    expect(isAllowedMcpHttpUrl('http://[0:0:0:0:0:0:0:1]:8080/mcp')).toBe(true)
  })

  it('refuses a url carrying an ASCII control character or a space, rather than canonicalising it', () => {
    // The parser TRIMS leading/trailing C0-and-space and REMOVES tab, LF and CR from anywhere, so
    // each of these parses to a different string than it reads as, and the admitted string is
    // stored and written verbatim into the agent CLI's MCP config. Refused so that what was
    // admitted and what is started cannot be two different urls.
    for (const noisy of [
      ' https://mcp.example.com',
      'https://mcp.example.com ',
      'https://mcp.\texample.com',
      'https://mcp.example.com/a b',
      'http://127.0.0.1\n@evil.example',
    ]) {
      expect(isAllowedMcpHttpUrl(noisy), JSON.stringify(noisy)).toBe(false)
    }
  })

  it('refuses a malformed host rather than reinterpreting it into a loopback one', () => {
    // An unterminated IPv6 bracket, or a stray `]` in a name, must fall through as "not loopback".
    // Salvaging a host out of either is how a non-loopback name earns the cleartext exemption.
    for (const malformed of [
      'http://[127.0.0.1',
      'http://[localhost:',
      'http://x127.0.0.1]',
      'http://[]',
    ]) {
      expect(isAllowedMcpHttpUrl(malformed), malformed).toBe(false)
    }
  })

  it('refuses anything that is not an http(s) url at all', () => {
    for (const bad of [
      'ftp://127.0.0.1',
      'ws://127.0.0.1',
      'httpsx://mcp.example.com',
      '127.0.0.1:8080', // a scheme may not start with a digit, so this is not a url at all
      'see https://mcp.example.com', // a url MENTIONED in prose is not a url
      '',
    ]) {
      expect(isAllowedMcpHttpUrl(bad), bad).toBe(false)
    }
  })
})

describe('isLoopbackMcpHttpUrl', () => {
  it('answers where the server LIVES, independently of the scheme', () => {
    // The operability probe reads this one: the backend's own 127.0.0.1 is a different machine
    // from the run container's, so a loopback server is refused by name rather than probed. An
    // https sidecar is no more reachable from the backend than a cleartext one.
    expect(isLoopbackMcpHttpUrl('https://127.0.0.1:8080/mcp')).toBe(true)
    expect(isLoopbackMcpHttpUrl('http://localhost/mcp')).toBe(true)
    expect(isLoopbackMcpHttpUrl('https://[::1]/mcp')).toBe(true)
    expect(isLoopbackMcpHttpUrl('https://mcp.example.com/mcp')).toBe(false)
  })

  it('is false for a url it cannot parse', () => {
    expect(isLoopbackMcpHttpUrl('not-a-url')).toBe(false)
  })
})

describe('isValidMcpToolName', () => {
  it('refuses a comma, because the harness joins the allow-list with commas', () => {
    // One entry carrying a comma becomes two `--allowedTools` patterns, the second of which
    // matches no tool the CLI has — while the prompt goes on advertising the name verbatim.
    expect(isValidMcpToolName('search_issues,get_issue')).toBe(false)
    expect(isValidMcpToolName('search_issues')).toBe(true)
  })

  it('refuses whitespace and shell/glob punctuation', () => {
    for (const bad of ['search issues', ' search', 'search\n', 'search*', 'mcp__x__y!', '']) {
      expect(isValidMcpToolName(bad), bad).toBe(false)
    }
  })

  it('accepts the character set real MCP tool names use', () => {
    for (const good of ['search_issues', 'get-issue', 'issues.search', 'v2_search1']) {
      expect(isValidMcpToolName(good), good).toBe(true)
    }
  })
})
