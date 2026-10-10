import { describe, expect, it } from 'vitest'
import { piVersionServesMcp } from '../src/capability-report.js'

// The image reports `piMcpServers` only when the Pi binary it actually has can read `mcp.json`,
// because `PI_VERSION` is a build ARG a pool can override below the floor.

describe('piVersionServesMcp', () => {
  it.each(['0.99.0', '0.99.1\n', 'v0.99.1', '0.100.0', '1.0.0'])('accepts %j', (version) => {
    expect(piVersionServesMcp(version)).toBe(true)
  })

  it.each([undefined, '', '0.98.9', '0.87.1', 'pi', 'unknown 0.99.0'])('refuses %j', (version) => {
    expect(piVersionServesMcp(version)).toBe(false)
  })
})
