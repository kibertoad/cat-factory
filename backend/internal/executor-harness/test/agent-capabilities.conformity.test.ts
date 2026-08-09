import {
  HARNESS_BODY_CAPABILITIES as KERNEL_BODY_CAPABILITIES,
  MCP_SERVER_ID_PATTERN,
  MCP_TOOL_NAME_PATTERN,
  isAllowedMcpHttpUrl,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  HARNESS_BODY_CAPABILITIES,
  MCP_SERVER_ID_PATTERN as HARNESS_MCP_SERVER_ID_PATTERN,
  MCP_TOOL_NAME_PATTERN as HARNESS_MCP_TOOL_NAME_PATTERN,
  isAllowedMcpHttpUrl as harnessIsAllowedMcpHttpUrl,
} from '../src/agent-capabilities.js'
import { parseAgentJob } from '../src/job.js'

// The tool-server id pattern, the tool-name pattern and the HTTP-transport rule exist TWICE: once
// in kernel (where the backend refuses a bad registration at boot) and once here (where the harness
// refuses a bad job body at the container boundary). The image is built from `src/` plus typescript
// alone, so the harness can carry no runtime dependency on a workspace package — hence a copy,
// exactly as `src/host-markdown.ts` copies kernel's `hostMarkdown`.
//
// A copy of a REFUSAL rule is only acceptable if it cannot drift: a harness that accepted an id
// kernel rejects would write a malformed Codex TOML key, one that accepted a cleartext URL kernel
// rejects would put a resolved credential on the wire, and a disagreement about tool names splits
// an `--allowedTools` argument into patterns that match nothing. So all three are pinned here — the
// patterns by source equality, the URL rule over the corpus of shapes that decide it.

describe('harness MCP server id pattern conforms to kernel', () => {
  it('is the same pattern, not merely a compatible one', () => {
    expect(HARNESS_MCP_SERVER_ID_PATTERN.source).toBe(MCP_SERVER_ID_PATTERN.source)
    expect(HARNESS_MCP_SERVER_ID_PATTERN.flags).toBe(MCP_SERVER_ID_PATTERN.flags)
  })
})

describe('harness MCP tool-name pattern conforms to kernel', () => {
  it('is the same pattern, not merely a compatible one', () => {
    expect(HARNESS_MCP_TOOL_NAME_PATTERN.source).toBe(MCP_TOOL_NAME_PATTERN.source)
    expect(HARNESS_MCP_TOOL_NAME_PATTERN.flags).toBe(MCP_TOOL_NAME_PATTERN.flags)
  })

  it('refuses the comma on both sides', () => {
    // The property the pair exists for, asserted directly so a conforming-but-wrong copy (both
    // drifting together) still fails: the runner joins the list into one argument with commas.
    expect(HARNESS_MCP_TOOL_NAME_PATTERN.test('search_issues,get_issue')).toBe(false)
    expect(MCP_TOOL_NAME_PATTERN.test('search_issues,get_issue')).toBe(false)
    expect(HARNESS_MCP_TOOL_NAME_PATTERN.test('search_issues')).toBe(true)
  })
})

const URL_CORPUS: string[] = [
  'https://mcp.example.com/sse',
  'https://mcp.example.com:8443/sse',
  'http://localhost:3000/mcp',
  'http://127.0.0.1:3000/mcp',
  'http://127.9.9.9/mcp',
  'http://[::1]:3000/mcp',
  'http://mcp.example.com/sse',
  'http://127.0.0.1.evil.example/mcp',
  // Userinfo that dresses a public host up as loopback (and the reverse).
  'http://127.0.0.1@evil.example/mcp',
  'http://evil.example@127.0.0.1/mcp',
  'http://user@evil.example@127.0.0.1/mcp',
  // Delimiters that end the authority. The backslash is the one a hand-written `[^/?#]*` scan
  // misses, and missing it is what turns the userinfo rule into the spoof it exists to refuse.
  'http://evil.example\\@127.0.0.1/mcp',
  'http://evil.example/@127.0.0.1',
  'http://evil.example#@127.0.0.1',
  // Spellings of loopback the URL parser normalises before dialling.
  'http://127.1/mcp',
  'http://0177.0.0.1/mcp',
  'http://2130706433/mcp',
  'http://[0:0:0:0:0:0:0:1]/mcp',
  // Strings the parser would canonicalise rather than read as written.
  ' https://mcp.example.com/sse',
  'https://mcp.example.com/sse ',
  'http://127.0.0.1\t@evil.example/mcp',
  'HTTPS://MCP.EXAMPLE.COM/sse',
  'HTTP://LOCALHOST/mcp',
  'ws://mcp.example.com/sse',
  'file:///etc/passwd',
  'javascript:alert(1)',
  '//mcp.example.com/sse',
  'not a url',
  '',
]

describe('harness HTTP transport rule conforms to kernel', () => {
  for (const url of URL_CORPUS) {
    it(`agrees on ${url || '(empty)'}`, () => {
      expect(harnessIsAllowedMcpHttpUrl(url)).toBe(isAllowedMcpHttpUrl(url))
    })
  }

  // The properties the rule exists for, asserted directly so a conforming-but-wrong pair (both
  // drifting together) still fails.
  it('allows https anywhere and plain http only on loopback', () => {
    expect(harnessIsAllowedMcpHttpUrl('https://mcp.example.com/sse')).toBe(true)
    expect(harnessIsAllowedMcpHttpUrl('http://localhost:3000/mcp')).toBe(true)
    expect(harnessIsAllowedMcpHttpUrl('http://[::1]:3000/mcp')).toBe(true)
    expect(harnessIsAllowedMcpHttpUrl('http://mcp.example.com/sse')).toBe(false)
  })

  it('is not fooled by loopback in the userinfo, nor by a loopback-prefixed hostname', () => {
    expect(harnessIsAllowedMcpHttpUrl('http://127.0.0.1@evil.example/mcp')).toBe(false)
    expect(harnessIsAllowedMcpHttpUrl('http://127.0.0.1.evil.example/mcp')).toBe(false)
    // The same spoof spelled with the delimiter a hand-written authority scan does not stop at.
    expect(harnessIsAllowedMcpHttpUrl('http://evil.example\\@127.0.0.1/mcp')).toBe(false)
  })

  // Agreement between the two copies is only worth having if what they agree ON is right, and a
  // hand-maintained table of expected verdicts cannot say that: a spoof neither side had thought
  // of is absent from it, so both sides pass while both are wrong (which is exactly how the
  // backslash survived). So derive the expectation from the AUTHORITY instead: the same WHATWG
  // parser `fetch` and the agent CLI resolve the request with. Whatever else the rule does, a
  // cleartext url it admits must reach a host that really is loopback.
  it('grants the cleartext exemption only to urls the REQUEST resolves to a loopback host', () => {
    const cleartext = URL_CORPUS.filter(
      (url) => url.toLowerCase().startsWith('http://') && harnessIsAllowedMcpHttpUrl(url),
    )
    // Guard the guard: an empty filter would pass this vacuously.
    expect(cleartext.length).toBeGreaterThan(0)
    for (const url of cleartext) {
      const hostname = new URL(url).hostname
      expect(
        hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname),
        `${url} was admitted for cleartext but really reaches ${hostname}`,
      ).toBe(true)
    }
  })

  it('refuses every non-http(s) scheme', () => {
    expect(harnessIsAllowedMcpHttpUrl('ws://mcp.example.com/sse')).toBe(false)
    expect(harnessIsAllowedMcpHttpUrl('file:///etc/passwd')).toBe(false)
  })
})

describe('harness body-capability list conforms to kernel', () => {
  it('names exactly the capabilities kernel checks a dispatch against', () => {
    // Order-insensitive: the harness reports a list, the backend does set membership over it.
    expect([...HARNESS_BODY_CAPABILITIES].sort()).toEqual([...KERNEL_BODY_CAPABILITIES].sort())
  })

  it('names only fields this image actually parses', () => {
    // The property the list exists for. A member added ahead of the parser would make the
    // handshake assert something false (precisely the blind run it was built to prevent), and
    // no equality check against kernel can see that, since both sides would agree and both be
    // wrong. So drive the real parser with a body carrying every declared capability and assert
    // each one survives onto the parsed job.
    const job = parseAgentJob({
      jobId: 'job-1',
      mode: 'coding',
      systemPrompt: 'sys',
      userPrompt: 'user',
      model: 'anthropic:claude',
      harness: 'claude-code',
      subscriptionToken: 'tok',
      ghToken: 'gh',
      branch: 'main',
      repo: {
        owner: 'o',
        name: 'r',
        cloneUrl: 'https://github.com/o/r.git',
        baseBranch: 'main',
      },
      mcpServers: [{ id: 'docs', transport: 'http', url: 'https://mcp.example.com/mcp' }],
      skills: [{ name: 'triage', description: 'd', instructions: 'do the thing' }],
      designImages: {
        url: 'https://proxy.example.com/v1/artifacts/reference',
        token: 'sess',
        files: [{ artifactId: 'art1', fileName: 'checkout.png', view: 'Checkout' }],
      },
    })
    for (const capability of HARNESS_BODY_CAPABILITIES) {
      expect((job as unknown as Record<string, unknown>)[capability]).toBeDefined()
    }
  })
})
