import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { agentCapabilities } from '../src/agent-shared.js'
import type { AgentJob } from '../src/job.js'

// EVERY mode that runs an agent must forward the job's CAPABILITY fields through the one helper.
//
// A structural guard, the sibling of `pr-template.coverage.test.ts`, and for the same reason: the
// bug is structural and silent. Each mode builds its own spec literal, so a mode that omits a
// capability compiles, passes every behavioural test, and simply runs an agent without its kind's
// declared playbook, tool servers or web research. Nothing fails; the output is just worse.
//
// This is not hypothetical. The conflict-resolver and the bootstrapper each hand-wrote their spec
// and were missing BOTH web-research fields, so a deployment that serves web research had two
// flows whose agents were never given it. The fix was to move those fields into the helper the
// other flows already spread, which is what this guard now pins: a new mode fails until it either
// spreads `agentCapabilities(job)` or is named below with the reason it cannot.
//
// The rule is anchored on `runAgentInWorkspace(` rather than on any one capability, because the
// point is the SET: a mode that remembers skills and forgets web tools is the exact failure this
// helper exists to make unrepresentable, and enumerating fields here would just move the omission
// into this file.

/** Agent-running modes that legitimately forward no capabilities, and why. State the reason. */
const FORWARDS_NO_CAPABILITIES: Record<string, string> = {
  runCodingAgent:
    'Takes an AgentRunSpec, not an AgentJob: its caller (buildSingleRepoCodingSpec) already ' +
    'read the job through the helper, and this function forwards what it was handed.',
}

const SOURCES = [
  '../src/agent.ts',
  '../src/coding-agent.ts',
  '../src/multi-repo-coding.ts',
  '../src/bootstrap-mode.ts',
]

const DECLARATION =
  /^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+)\s*[:=][^=\n]*=>/gm

function topLevelFunctions(source: string): Map<string, string> {
  const bodies = new Map<string, string>()
  const starts = [...source.matchAll(DECLARATION)]
  starts.forEach((match, index) => {
    const from = match.index
    const to = starts[index + 1]?.index ?? source.length
    bodies.set((match[1] ?? match[2])!, source.slice(from, to))
  })
  return bodies
}

/**
 * Every top-level function that runs an agent, PLUS the exported spec builders that assemble one
 * mode's spec a function away from the run. `buildSingleRepoCodingSpec` is the second kind: it
 * reads the job and `runCodingAgent` only forwards, so anchoring on the run alone would classify
 * the forwarder and never look at the reader.
 */
async function agentRunningModes(): Promise<Map<string, string>> {
  const modes = new Map<string, string>()
  for (const relative of SOURCES) {
    const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    for (const [name, body] of topLevelFunctions(source)) {
      if (body.includes('runAgentInWorkspace(') || name.endsWith('CodingSpec')) {
        modes.set(name, body)
      }
    }
  }
  return modes
}

describe('every agent-running mode forwards the job’s capabilities', () => {
  it('classifies every mode', async () => {
    const unclassified: string[] = []
    const forwarding: string[] = []
    for (const [name, body] of await agentRunningModes()) {
      if (body.includes('agentCapabilities(job)')) forwarding.push(name)
      else if (!(name in FORWARDS_NO_CAPABILITIES)) unclassified.push(name)
    }
    expect(unclassified).toEqual([])
    // A guard that silently matched nothing would pass forever, so pin that the modes it DID find
    // are the ones that exist. Derived from the sources rather than a hand-kept count.
    expect(forwarding.length).toBeGreaterThan(0)
    expect(forwarding.length + Object.keys(FORWARDS_NO_CAPABILITIES).length).toBe(
      (await agentRunningModes()).size,
    )
  })

  it('never re-spreads a capability field the helper already carries', async () => {
    // Re-spreading is how the multi-repo flow drifted: it listed four of the six fields by hand
    // beside the helper's own callers, so the two lists could disagree and did. A field read
    // straight off the job at a mode's own spec site is that same divergence starting again.
    const helperFields = Object.keys(
      agentCapabilities({
        skills: [{ name: 's', files: [] }],
        mcpServers: [{ id: 'm', transport: 'stdio', command: 'npx' }],
        generateImages: true,
        referenceScreenshots: { images: [] },
        designImages: { images: [] },
        webSearch: true,
        webToolsGuidance: 'g',
      } as unknown as AgentJob),
    )
    expect(helperFields.length).toBeGreaterThan(0)
    for (const [name, body] of await agentRunningModes()) {
      if (name in FORWARDS_NO_CAPABILITIES) continue
      for (const field of helperFields) {
        expect(body, `${name} hand-writes ${field} the helper already forwards`).not.toMatch(
          new RegExp(`\\b${field}: job\\.`),
        )
      }
    }
  })
})

describe('agentCapabilities', () => {
  it('carries web research, so a mode cannot forward tool servers and drop the web tools', () => {
    const job = { webSearch: true, webToolsGuidance: 'search sparingly' } as unknown as AgentJob
    expect(agentCapabilities(job)).toEqual({
      webSearchProxy: true,
      webToolsGuidance: 'search sparingly',
    })
  })

  it('omits what the job did not state rather than asserting a default', () => {
    // Absent and false are different facts on this seam: `webSearchProxy: false` would be a claim
    // the backend never made, and the Pi path reads the field's PRESENCE.
    expect(agentCapabilities({} as AgentJob)).toEqual({})
  })
})
