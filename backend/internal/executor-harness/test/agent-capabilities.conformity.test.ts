import { MCP_SERVER_ID_PATTERN, isAllowedMcpHttpUrl } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  MCP_SERVER_ID_PATTERN as HARNESS_MCP_SERVER_ID_PATTERN,
  isAllowedMcpHttpUrl as harnessIsAllowedMcpHttpUrl,
} from '../src/agent-capabilities.js'

// The tool-server id pattern and the HTTP-transport rule exist TWICE: once in kernel (where the
// backend refuses a bad registration at boot) and once here (where the harness refuses a bad job
// body at the container boundary). The image is built from `src/` plus typescript alone, so the
// harness can carry no runtime dependency on a workspace package — hence a copy, exactly as
// `src/host-markdown.ts` copies kernel's `hostMarkdown`.
//
// A copy of a REFUSAL rule is only acceptable if it cannot drift: a harness that accepted an id
// kernel rejects would write a malformed Codex TOML key, and one that accepted a cleartext URL
// kernel rejects would put a resolved credential on the wire. So both are pinned here — the
// pattern by source equality, the URL rule over the corpus of shapes that decide it.

describe('harness MCP server id pattern conforms to kernel', () => {
  it('is the same pattern, not merely a compatible one', () => {
    expect(HARNESS_MCP_SERVER_ID_PATTERN.source).toBe(MCP_SERVER_ID_PATTERN.source)
    expect(HARNESS_MCP_SERVER_ID_PATTERN.flags).toBe(MCP_SERVER_ID_PATTERN.flags)
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
  })

  it('refuses every non-http(s) scheme', () => {
    expect(harnessIsAllowedMcpHttpUrl('ws://mcp.example.com/sse')).toBe(false)
    expect(harnessIsAllowedMcpHttpUrl('file:///etc/passwd')).toBe(false)
  })
})
