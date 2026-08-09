import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// EVERY mode that runs an agent AND opens a pull request must resolve the repo's PR template.
//
// A structural guard, for the same reason `dependency-install.coverage.test.ts` is one: the bug is
// structural and silent. Each harness mode owns its own flow, so a PR-opening mode that never
// resolves the template compiles, passes every behavioural test, and simply opens pull requests
// that ignore the repo's convention — the exact failure this feature exists to fix, reintroduced
// on one path.
//
// The rule cannot be anchored on `openPullRequest(` itself: both call sites live in the PUSH phase
// (`runSingleRepoCoding`, `pushMultiRepoLegs`), a function or two below the one that ran the agent,
// and the template has to reach the agent's PROMPT — so by the time a PR is opened it is far too
// late. What is locally visible is the agent run, so every agent-running mode is CLASSIFIED here:
// it either resolves the template note, or it is named below with the reason it opens no pull
// request. A new mode fails this test until it is classified, which is the point.

/** Agent-running modes that open NO pull request, and why. Not a landing pad — state the reason. */
const OPENS_NO_PULL_REQUEST: Record<string, string> = {
  runExploreMode:
    'Read-only exploration (reviewers, architects, testers). Produces a report, never a branch.',
  runMultiRepoExplore: 'The multi-repo fan-out of the above; read-only in every leg.',
  runConflictResolution:
    "Pushes the resolved merge onto an ALREADY-OPEN pull request's branch. Filling a template " +
    "here would rewrite the implementer's published description with a fresh one.",
  runBootstrap:
    'Force-pushes one commit into a brand-new empty repo. There is no pull request, and the ' +
    'target repo carries no template to respect yet.',
}

const SOURCES = [
  '../src/agent.ts',
  '../src/coding-agent.ts',
  '../src/multi-repo-coding.ts',
  '../src/bootstrap-mode.ts',
]

/**
 * Top-level function bodies, keyed by name. Crude on purpose, as in the sibling guard — the two
 * markers only ever appear at statement level in these files.
 *
 * Both spellings a top-level mode can take: a `function` declaration, and a `const x = async () =>`
 * arrow. The arrow form matters because this guard's whole claim is that a NEW mode fails until it
 * is classified, and a claim that holds for only one of the two ways to write one is not that.
 */
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

async function agentRunningModes(): Promise<Map<string, string>> {
  const modes = new Map<string, string>()
  for (const relative of SOURCES) {
    const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    for (const [name, body] of topLevelFunctions(source)) {
      if (body.includes('runAgentInWorkspace(')) modes.set(name, body)
    }
  }
  return modes
}

describe('the PR template reaches every mode that opens a pull request', () => {
  it('classifies every agent-running mode', async () => {
    const unclassified: string[] = []
    const resolving: string[] = []
    for (const [name, body] of await agentRunningModes()) {
      const resolves = body.includes('resolvePrTemplateNote(')
      if (resolves) resolving.push(name)
      else if (!(name in OPENS_NO_PULL_REQUEST)) unclassified.push(name)
    }
    expect(unclassified).toEqual([])
    // A guard that silently matched nothing would pass forever. Pin the two PR-opening modes:
    // single-repo coding (which the in-place fixers also run through, gated on `opensPr`) and
    // multi-repo coding (gated per leg on whether that leg opens a PR).
    expect(resolving.sort()).toEqual(['runCodingAgent', 'runMultiRepoCoding'])
  })

  it('folds the resulting note into the prompt of every one of them', async () => {
    // Resolving without folding is the whole feature missing while looking present — and it is a
    // live hazard here, since the note has to survive being composed alongside the dependency note.
    for (const [name, body] of await agentRunningModes()) {
      if (!body.includes('resolvePrTemplateNote(')) continue
      expect(body, `${name} resolves the PR template but never tells the agent`).toContain(
        'withPrTemplateNote(',
      )
    }
  })

  it('never asks a mode that opens no pull request to fill a template', async () => {
    for (const [name, body] of await agentRunningModes()) {
      if (!(name in OPENS_NO_PULL_REQUEST)) continue
      expect(body, `${name} opens no pull request but resolves a template`).not.toContain(
        'resolvePrTemplateNote(',
      )
    }
  })
})
