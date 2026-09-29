import { execFile } from 'node:child_process'
import { HARNESS_BODY_CAPABILITIES } from './agent-capabilities.js'

// What this image REPORTS in the capability handshake (`/health` and the job acceptance), as
// opposed to what its parser reads (`HARNESS_BODY_CAPABILITIES`, pinned against kernel).
//
// The two differ by exactly one member. Every other capability is served by this image's own code,
// so parsing the field IS serving it. `piMcpServers` is served by the Pi binary the image happens
// to have installed, and `PI_VERSION` is a Docker build ARG a self-hosted pool can override: an
// image built with an older Pi would parse the servers, write the config, and have it ignored,
// while the prompt promises the tools. So that member is reported only after the installed binary
// has been asked for its version, and a binary that cannot answer is treated as not serving it.

/** The first Pi release with a built-in MCP client that reads `mcp.json`. */
const PI_MCP_MIN_VERSION: readonly [number, number, number] = [0, 99, 0]

/** How long the one-off `pi --version` probe may take before it counts as "no answer". */
const PI_VERSION_PROBE_TIMEOUT_MS = 15_000

/**
 * Whether a `pi --version` answer names a release that serves `mcp.json`. Pure, so the gate is
 * testable without a binary. Anything that is not a plain `major.minor.patch` (a missing binary, a
 * garbled answer) is `false`: the capability is a PROMISE, and an unreadable version cannot back
 * one.
 */
export function piVersionServesMcp(version: string | undefined): boolean {
  const match = version?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return false
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])]
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]! !== PI_MCP_MIN_VERSION[i]!) return parts[i]! > PI_MCP_MIN_VERSION[i]!
  }
  return true
}

function probePiVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('pi', ['--version'], { timeout: PI_VERSION_PROBE_TIMEOUT_MS }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    )
  })
}

let report: Promise<readonly string[]> | undefined

/**
 * The capability list this image reports. Probed once per process (the installed binary cannot
 * change under a running image) and never rejects: a failed probe is the answer "Pi does not serve
 * MCP here", which is the safe one.
 */
export function reportedBodyCapabilities(): Promise<readonly string[]> {
  report ??= probePiVersion().then((version) =>
    HARNESS_BODY_CAPABILITIES.filter(
      (capability) => capability !== 'piMcpServers' || piVersionServesMcp(version),
    ),
  )
  return report
}
