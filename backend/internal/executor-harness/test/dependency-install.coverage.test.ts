import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// EVERY mode that runs an agent over a checkout must run the DEPENDENCY PREPOPULATION phase.
//
// This is a structural guard, not a behavioural one, because the bug it exists to catch is
// structural and silent. The backend puts `dependencyInstall` on the BASE job body — every
// dispatch that gets a checkout carries it — but each harness mode has its own flow, so a mode
// that simply never reads the field compiles, passes every test, and leaves its agent exactly as
// blind as before. That is precisely what shipped in the first cut: three modes wired, two
// (multi-repo coding, conflict resolution) not, with nothing anywhere failing to say so.
//
// So the rule is asserted at the only place it is visible: a function that calls
// `runAgentInWorkspace` runs an agent against a checkout, and must therefore also call
// `prepopulateDependencies` — unless it is named below WITH a reason. A new mode inherits the
// assertion for free; an exemption has to be argued for in writing.

/** Modes that run an agent but legitimately have no service install to run. */
const EXEMPT: Record<string, string> = {
  runBootstrap:
    'Adapts a reference into a brand-new EMPTY target repo. The service frame it will become ' +
    'does not exist yet, so there is no config to resolve and nothing on disk to install from.',
}

const SOURCES = [
  '../src/agent.ts',
  '../src/coding-agent.ts',
  '../src/multi-repo-coding.ts',
  '../src/bootstrap-mode.ts',
]

/**
 * Top-level function bodies, keyed by name. Crude on purpose: a real parse would buy nothing
 * here, since the two markers only ever appear at statement level in these files.
 */
function topLevelFunctions(source: string): Map<string, string> {
  const bodies = new Map<string, string>()
  const starts = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)]
  starts.forEach((match, index) => {
    const from = match.index
    const to = starts[index + 1]?.index ?? source.length
    bodies.set(match[1]!, source.slice(from, to))
  })
  return bodies
}

describe('dependency prepopulation reaches every mode with a checkout', () => {
  it('is run by every function that runs an agent over a checkout', async () => {
    const offenders: string[] = []
    const covered: string[] = []
    for (const relative of SOURCES) {
      const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      for (const [name, body] of topLevelFunctions(source)) {
        if (!body.includes('runAgentInWorkspace(')) continue
        if (name in EXEMPT) continue
        if (body.includes('prepopulateDependencies(')) covered.push(name)
        else offenders.push(name)
      }
    }
    expect(offenders).toEqual([])
    // A guard that silently matched nothing would pass forever. Pin the modes it is watching:
    // read-only exploration, its multi-repo fan-out, single-repo coding (which the in-place
    // fixers also run through), multi-repo coding, and conflict resolution.
    expect(covered.sort()).toEqual([
      'runCodingAgent',
      'runConflictResolution',
      'runExploreMode',
      'runMultiRepoCoding',
      'runMultiRepoExplore',
    ])
  })

  it('folds the resulting note into the prompt of every one of them', async () => {
    // The install without the note is half the feature: an agent that finds a populated tree and
    // no explanation still re-runs the install "to be safe", and one that finds an empty tree
    // concludes the environment is offline. Both were paid for and neither was stated.
    for (const relative of SOURCES) {
      const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      for (const [name, body] of topLevelFunctions(source)) {
        if (!body.includes('prepopulateDependencies(')) continue
        expect(body, `${name} runs the install but never tells the agent`).toContain(
          'withDependencyNote(',
        )
      }
    }
  })
})
