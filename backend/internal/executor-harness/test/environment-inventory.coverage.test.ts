import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { carryClaudeSystemPrompt } from '../src/agent-runner.js'
import { renderEnvironmentInventory } from '../src/environment-inventory.js'

// EVERY container-running mode gets the environment inventory EXACTLY ONCE, and it gets it by
// inheritance rather than by remembering to fold it.
//
// This is a structural guard because the bug it exists to catch is structural and silent, in both
// directions. A mode that folded its own copy would state the machine twice in one system prompt;
// a mode that folded none would leave its agent probing, and neither shows up as a failure
// anywhere. The harness has five agent-running flows across four files (explore, coding, its
// multi-repo pair, bootstrap, conflict resolution) plus three CLIs underneath them, so "remember
// to fold it" is not a design.
//
// The design is one composition point in `handleAgent`, writing onto the job's OWN
// `systemPrompt`, which every flow already forwards. So the rule asserted here has two halves:
// nothing outside that one call site may reference the composer, and every flow that runs an
// agent must forward the job's field rather than build a prompt of its own.

const COMPOSER = 'appendEnvironmentInventory('

/** Every harness source that runs an agent, plus the entry point that composes for all of them. */
const SOURCES = [
  '../src/agent.ts',
  '../src/coding-agent.ts',
  '../src/multi-repo-coding.ts',
  '../src/bootstrap-mode.ts',
  '../src/pi-workspace.ts',
  '../src/inline.ts',
]

async function read(relative: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/**
 * Top-level function bodies, keyed by name. Crude on purpose, and the same crude split
 * `dependency-install.coverage.test.ts` uses: the markers only ever appear at statement level.
 *
 * It matches an arrow-assigned function as well as a `function` declaration, because a guard whose
 * TOTALITY is the point cannot be blind to a way of writing the thing it is total over: with only
 * `function` matched, `export const runNewMode = async (job) => { ... }` was invisible to both
 * assertions below, so the new flow neither counted as a caller nor had its forwarding checked, and
 * the exact double-fold this file exists to prevent would have landed green.
 */
function topLevelFunctions(source: string): Map<string, string> {
  // Either shape a top-level function is written in here: a `function` declaration, or a `const`
  // bound to an arrow or function expression. Group 1 names the first, group 2 the second.
  const declaration =
    /^(?:export )?(?:async )?function (\w+)|^(?:export )?(?:const|let) (\w+)(?::[^=\n]+)? = (?:async )?(?:\(|function\b)/gm
  const starts = [...source.matchAll(declaration)].map((match) => ({
    index: match.index,
    name: match[1] ?? match[2]!,
  }))
  const bodies = new Map<string, string>()
  starts.forEach((start, index) => {
    bodies.set(start.name, source.slice(start.index, starts[index + 1]?.index ?? source.length))
  })
  return bodies
}

describe('the environment inventory is composed exactly once', () => {
  it('is folded at ONE call site, in handleAgent', async () => {
    const callers: string[] = []
    for (const relative of SOURCES) {
      const source = await read(relative)
      for (const [name, body] of topLevelFunctions(source)) {
        if (body.includes(COMPOSER)) callers.push(`${relative.split('/').pop()}:${name}`)
      }
    }
    expect(callers).toEqual(['agent.ts:handleAgent'])
  })

  it('is inherited by every agent-running flow through the job it was folded onto', async () => {
    // A flow that ran an agent off a prompt it composed itself would bypass the fold above with
    // nothing failing. Every one of them passes the field through instead, so the count of flows
    // is not pinned here (an added mode joins for free). What is pinned is that none of them
    // builds its own.
    const forwarding: string[] = []
    for (const relative of SOURCES) {
      const source = await read(relative)
      for (const [name, body] of topLevelFunctions(source)) {
        // Skip the funnel's own definition; it is the callee, and its handling is asserted below.
        if (name === 'runAgentInWorkspace' || !body.includes('runAgentInWorkspace(')) continue
        expect(body, `${name} must forward the job's own system prompt`).toMatch(
          /systemPrompt: (job|spec)\.systemPrompt/,
        )
        forwarding.push(name)
      }
    }
    expect(forwarding.length).toBeGreaterThan(0)
  })

  it('is carried into all three CLIs by the one funnel, not re-derived per CLI', async () => {
    // `runAgentInWorkspace` is where the harness picks a CLI, and it is the last place the system
    // prompt could be dropped: the subscription branch hands it to claude-code/codex, the Pi
    // branch writes it to `~/.pi/agent/AGENTS.md`. Both must start from the spec's own field,
    // which is the field `handleAgent` folded the inventory onto.
    const funnel = topLevelFunctions(await read('../src/pi-workspace.ts')).get(
      'runAgentInWorkspace',
    )!
    expect(funnel).toContain('subscriptionSystemPrompt(spec.systemPrompt')
    expect(funnel).toContain('writeAgentsContext(spec.systemPrompt')
  })

  it('sees a flow written as an arrow function, not only as a `function`', () => {
    // The guard above is only worth its assertions if it is TOTAL over the ways a flow can be
    // written. Matching `function` alone made an arrow-assigned mode invisible to both halves: it
    // was not counted as a caller and its forwarding was never checked, so the double-fold this
    // file exists to catch would have landed green. Asserted against the matcher directly, because
    // no source in the tree currently takes that shape, which is exactly why it went unnoticed.
    const fixture = [
      'export async function runOldMode(job) {',
      '  return appendEnvironmentInventory(job.systemPrompt)',
      '}',
      'export const runNewMode = async (job: AgentJob): Promise<void> => {',
      '  await appendEnvironmentInventory(job.systemPrompt)',
      '}',
      'const NOT_A_FUNCTION = [1, 2, 3]',
    ].join('\n')
    const found = topLevelFunctions(fixture)
    expect([...found.keys()]).toEqual(['runOldMode', 'runNewMode'])
    expect(found.get('runNewMode')).toContain(COMPOSER)
  })

  it('reaches the agent whichever way the claude runner has to carry the prompt', () => {
    // The one branch that could drop it. A system prompt small enough for argv rides
    // `--append-system-prompt`; one too large for a single argv string is folded into the stdin
    // task prompt instead. The block is appended to the SYSTEM prompt, so both carry it whole,
    // and the oversized branch is the live one for a coder with best-practice fragments folded
    // in, which is exactly where the inventory would otherwise have gone missing.
    //
    // The REAL block, not a one-line stand-in for it: what the fold has to survive is this text's
    // actual shape (several lines, embedded backticks around `docker build` and `npx <manager>`),
    // and a sentinel string proved only that an arbitrary line survives.
    const block = renderEnvironmentInventory({
      tools: [
        { name: 'node', showVersion: true, presence: { status: 'present', version: '26.7.0' } },
        { name: 'pnpm', showVersion: true, presence: { status: 'absent' } },
        {
          name: 'make',
          showVersion: false,
          presence: { status: 'unknown', reason: 'the probe timed out' },
        },
      ],
      dockerDaemon: { status: 'absent' },
    })
    expect(block).toContain('\n')
    expect(block).toContain('`')

    const small = carryClaudeSystemPrompt(`ROLE\n\n${block}`, 'TASK')
    expect(small.folded).toBe(false)
    expect(small.appendArgs.join('\n')).toContain(block)

    const big = carryClaudeSystemPrompt(`${'x'.repeat(200_000)}\n\n${block}`, 'TASK')
    expect(big.folded).toBe(true)
    expect(big.prompt).toContain(block)
    expect(big.prompt).toContain('TASK')
  })

  it('is not folded onto the checkout-free inline completion', async () => {
    // The inline kind runs no shell and reads no filesystem, so an inventory of a machine it
    // cannot reach would be the platform describing an environment the dispatch never delivered.
    // Stated here rather than left to the reader of the call-site list above.
    expect(await read('../src/inline.ts')).not.toContain(COMPOSER)
  })
})
