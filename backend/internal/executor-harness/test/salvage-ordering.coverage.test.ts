import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The salvage must be COMMITTED before the two pre-PR phases decide whether to run.
//
// A structural guard, because the bug it pins is structural and silent. Both phases are gated on
// `producedWork`, which reads COMMITS; the salvage commits the new files an agent created and
// never added. Run last, as it was, that gate is false for exactly the runs the salvage exists to
// save: a greenfield task whose every file is new and uncommitted skipped validation entirely, and
// then opened a pull request with `validationReport === undefined`, so the caller's
// `if (validationReport && !validationReport.passed)` refusal never fired. "Only a green checkout
// opens a PR" held for every run except those.
//
// Nothing behavioural catches that. `runCodingAgent` needs a container and an agent; the ordering
// is visible only in the source, and the two calls are a hundred lines apart in a function whose
// tail was extracted into `finalizeCodingRun`. So assert the order the source states, and the
// second, mop-up pass that keeps a repair round's own new files from being dropped by the move.

const CODING_AGENT = fileURLToPath(new URL('../src/coding-agent.ts', import.meta.url))

/** Every module that opens a pull request. Both are salvage-aware; see the second describe. */
const PR_OPENERS = ['../src/agent.ts', '../src/multi-repo-coding.ts']

const read = (): Promise<string> => readFile(CODING_AGENT, 'utf8')

describe('the salvage runs ahead of the pre-PR phases', () => {
  /** `runCodingAgent`'s own body, where the three calls whose ORDER is the fix sit. */
  const runBody = async (): Promise<string> => {
    const source = await read()
    const from = source.indexOf('export async function runCodingAgent(')
    expect(from).toBeGreaterThan(-1)
    // Up to the first top-level declaration after it: the extracted collaborators live below.
    const to = source.indexOf('\n/**', from)
    return source.slice(from, to === -1 ? source.length : to)
  }

  it('commits what the agent left before either phase reads the branch', async () => {
    const body = await runBody()
    const settle = body.indexOf('await settleAgentWork(')
    const reproduction = body.indexOf('await runReproductionPhase({')
    const validation = body.indexOf('await runValidationLoop({')
    expect(settle).toBeGreaterThan(-1)
    expect(reproduction).toBeGreaterThan(-1)
    expect(validation).toBeGreaterThan(-1)
    expect(settle).toBeLessThan(reproduction)
    expect(settle).toBeLessThan(validation)
  })

  it('is what settleAgentWork actually does, in the order that makes the claim true', async () => {
    // The call above only puts the step in the right place; this pins what the step is. Both
    // phases gate on `producedWork`, which reads COMMITS, so the salvage has to have COMMITTED by
    // the time they run, and `committedOwnWork` has to be read before it does, or the salvage's
    // own commit answers the question "did the agent commit anything here".
    const source = await read()
    const settle = source.slice(source.indexOf('async function settleAgentWork('))
    const tracked = settle.indexOf('await commitTrackedEdits(')
    const own = settle.indexOf('const committedOwnWork = await branchHasCommitsSince(')
    const salvage = settle.indexOf('await salvageUntrackedWork({')
    expect(tracked).toBeGreaterThan(-1)
    expect(own).toBeGreaterThan(tracked)
    expect(salvage).toBeGreaterThan(own)
  })

  it('still mops up after the phases, since a repair round runs the agent afresh', async () => {
    // Moving the salvage earlier would otherwise trade one silent loss for another: a repair pass
    // can create new files of its own after the pre-gate pass has already run.
    const source = await read()
    const finalize = source.slice(source.indexOf('async function finalizeCodingRun('))
    expect(finalize).toContain('foldSalvageReports(')
    expect(finalize).toContain('await salvageUntrackedWork({')
  })
})

describe('a pull request that is nothing but salvage says so', () => {
  // A branch the agent committed to not once, which exists only because the harness swept up what
  // it left in the checkout, is not a change anyone proposed. The multi-repo path had marked its
  // legs' pull requests for a while and the single-repo path had not, which meant the same branch
  // shape opened a marked or an unmarked PR depending only on how many repositories the run
  // happened to clone. Anchored on the `openPullRequest(` call sites because that is the one place
  // the body is finally decided, and there are exactly two of them.
  it('marks the body at every call site that opens one', async () => {
    for (const relative of PR_OPENERS) {
      const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      const opens = source.indexOf('openPullRequest({')
      expect(opens, `${relative} opens no pull request any more`).toBeGreaterThan(-1)
      // The `pr:` field of that call, which is what carries the body.
      const call = source.slice(opens, source.indexOf('})', opens))
      expect(call, `${relative} opens a PR without marking a salvage-only branch`).toContain(
        'withSalvageOnlyNote(',
      )
    }
  })
})
