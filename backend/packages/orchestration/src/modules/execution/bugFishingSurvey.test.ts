import { BLUEPRINT_JSON_PATH } from '@cat-factory/contracts'
import type { RepoContentEntry, RepoFiles } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { surveyCodebase, unavailableSurvey } from './bugFishingSurvey.js'

// The impure half of the territory design: which paths it reads, and what it answers when it can
// read nothing. Both are facts about the SEAM rather than about the partition (that is
// `bugFishingTerritories.logic.test.ts`), and both were silent when wrong.

function file(path: string, bytes: number): RepoContentEntry {
  return { path, name: path.split('/').pop()!, type: 'file', sha: `sha-${path}`, size: bytes }
}

/** A repo facade that records the paths asked for, over a fixed tree and a fixed file map. */
function fakeRepo(input: {
  entries: RepoContentEntry[]
  files?: Record<string, string>
  asked?: string[]
}): RepoFiles {
  return {
    getFile: async (path) => {
      input.asked?.push(path)
      const content = input.files?.[path]
      return content === undefined ? null : { path, content, sha: `sha-${path}` }
    },
    listDirectory: async () => [],
    listTree: async () => ({ entries: input.entries, truncated: false }),
    headSha: async () => 'base-sha',
    createBranch: async () => {},
    deleteBranch: async () => {},
    commitFiles: async () => ({ sha: 'commit-sha' }),
    openPullRequest: async () => {
      throw new Error('not exercised by this survey')
    },
  }
}

const bigTree = (root: string): RepoContentEntry[] => [
  { path: root, name: root.split('/').pop()!, type: 'dir', sha: `tree-${root}` },
  ...Array.from({ length: 4 }, (_, i) => file(`${root}/billing/f${i}.ts`, 200_000)),
  ...Array.from({ length: 4 }, (_, i) => file(`${root}/sessions/f${i}.ts`, 200_000)),
]

describe('surveyCodebase', () => {
  it('reads the blueprint where the post-op COMMITS it: the repository root', async () => {
    // `blueprintPostOp` writes through a root-scoped `RepoFiles`, with no service prefix, whatever
    // subdirectory the service lives in. Reading it under the service directory found nothing on
    // every monorepo service, and found it silently: the expedition simply fell through to the
    // directory heuristic with nothing on the record saying the service had a blueprint.
    const asked: string[] = []
    const blueprint = JSON.stringify({
      type: 'service',
      name: 'api',
      summary: '',
      references: [],
      modules: [{ name: 'Billing', summary: '', references: ['billing'] }],
    })
    const survey = await surveyCodebase({
      repo: fakeRepo({
        entries: bigTree('packages/api'),
        files: { [BLUEPRINT_JSON_PATH]: blueprint },
        asked,
      }),
      branch: 'main',
      serviceDirectory: 'packages/api',
    })
    expect(asked).toEqual([BLUEPRINT_JSON_PATH])
    const billing = survey.territories.find((t) => (t.roots ?? []).includes('billing'))
    expect(billing?.source).toBe('blueprint')
    expect(billing?.label).toBe('Billing')
  })

  it('accepts a blueprint reference written in EITHER frame', async () => {
    // The reference is written by whoever ran the Blueprinter, and the two authorings differ by
    // exactly the service prefix. Both name the same code.
    const survey = await surveyCodebase({
      repo: fakeRepo({
        entries: bigTree('packages/api'),
        files: {
          [BLUEPRINT_JSON_PATH]: JSON.stringify({
            type: 'service',
            name: 'api',
            summary: '',
            references: [],
            modules: [{ name: 'Billing', summary: '', references: ['packages/api/billing'] }],
          }),
        },
      }),
      branch: 'main',
      serviceDirectory: 'packages/api',
    })
    expect(survey.territories.find((t) => t.label === 'Billing')?.roots).toEqual(['billing'])
  })

  it('answers ONE whole-codebase territory plus a reason when nothing can be read', async () => {
    // Never an empty list: that is the value the step then persists as `territories: []`, which
    // claims the codebase was surveyed and found to contain nothing, and it leaves the planner
    // with no cell to name when the budget cuts an angle.
    const survey = await surveyCodebase({ repo: null, branch: 'main' })
    expect(survey.territories.map((t) => t.source)).toEqual(['whole-codebase'])
    expect(survey.unavailableReason).toBeTruthy()
    expect(unavailableSurvey('x').territories).toHaveLength(1)
  })

  it('degrades to the same answer, with its own cause, when the tree read fails', async () => {
    const repo = fakeRepo({ entries: [] })
    const survey = await surveyCodebase({
      repo: {
        ...repo,
        listTree: async () => {
          throw new Error('contents API blipped')
        },
      },
      branch: 'main',
    })
    expect(survey.territories).toHaveLength(1)
    expect(survey.unavailableReason).toContain('tree')
  })
})
