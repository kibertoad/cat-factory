import { describe, expect, it } from 'vitest'
import { checkIssueWriteback, fileReporterIssue, waitForIssueSettled } from '../src/issueIntake.ts'
import type { Journal } from '../src/journal.ts'
import type { IssueApi, IssueState } from '../src/vcsIssues.ts'
import type { IssueRecord } from '../src/world.ts'

// Two properties, and both are the kind that fail silently.
//
// The FILING is exactly-once across attempts. A pass that re-filed would leave the first issue open
// forever with the platform's own comments on it, and every assertion afterwards would pass against
// the second one, so nothing would go red.
//
// The GRADING must not accept a closed issue on its own. A provider closes an issue by itself when a
// merged pull request's text carries a closing keyword, and that path leaves no comment, so
// "closed" alone cannot tell the writeback from the host noticing a word an agent wrote.

const TARGET = { owner: 'acme', repo: 'catalog-api' }
const PR = 'https://github.com/acme/catalog-api/pull/12'

function journal(lines: string[] = []): Journal {
  return {
    say: (_kind: string, message: string) => void lines.push(message),
    record: (_kind: string, message: string) => void lines.push(message),
  } as unknown as Journal
}

function api(overrides: Partial<IssueApi> = {}): IssueApi {
  return {
    probe: async () => ({ status: 'ready' }),
    file: async () => ({ number: 7, url: 'https://github.com/acme/catalog-api/issues/7' }),
    read: async () => state({}),
    ...overrides,
  }
}

function state(overrides: Partial<IssueState>): IssueState {
  return {
    state: 'open',
    closed: false,
    url: 'https://github.com/acme/catalog-api/issues/7',
    comments: [],
    ...overrides,
  }
}

const RECORDED: IssueRecord = {
  provider: 'github',
  owner: 'acme',
  repo: 'catalog-api',
  number: 7,
  url: 'https://github.com/acme/catalog-api/issues/7',
}

describe('filing the reporter’s issue', () => {
  it('records the issue the moment it exists, before anything else can fail', async () => {
    // The window this guards is the one between the POST and the ledger write: an issue nobody
    // recorded is an issue the next attempt cannot find.
    const recorded: IssueRecord[] = []
    const record = await fileReporterIssue({
      api: api(),
      provider: 'github',
      target: TARGET,
      issue: { title: 't', body: 'b' },
      existing: null,
      journal: journal(),
      onRecord: (next) => void recorded.push(next),
    })
    expect(record).toEqual(RECORDED)
    expect(recorded).toEqual([RECORDED])
  })

  it('adopts the issue a previous attempt filed rather than filing a second one', async () => {
    let filed = 0
    const lines: string[] = []
    const record = await fileReporterIssue({
      api: api({
        file: async () => {
          filed += 1
          return { number: 99, url: 'https://github.com/acme/catalog-api/issues/99' }
        },
        read: async () => state({ comments: ['taken by cat-factory'] }),
      }),
      provider: 'github',
      target: TARGET,
      issue: { title: 't', body: 'b' },
      existing: RECORDED,
      journal: journal(lines),
      onRecord: () => {},
    })
    expect(filed).toBe(0)
    expect(record.number).toBe(7)
    expect(lines.join('\n')).toContain('adopting the issue a previous attempt filed')
  })

  it('files again, saying so, when the recorded issue is gone from the provider', async () => {
    // A `ticket` naming a missing issue refuses the task creation outright, so carrying on with the
    // ledger's number would fail the pass on a fault a person caused hours earlier.
    const lines: string[] = []
    const record = await fileReporterIssue({
      api: api({ read: async () => null }),
      provider: 'github',
      target: TARGET,
      issue: { title: 't', body: 'b' },
      existing: { ...RECORDED, number: 3 },
      journal: journal(lines),
      onRecord: () => {},
    })
    expect(record.number).toBe(7)
    expect(lines.join('\n')).toContain('no longer has it')
  })

  it('files again when the .env was re-pointed, naming which half moved', async () => {
    for (const [existing, expected] of [
      [{ ...RECORDED, provider: 'gitlab' }, "was filed on 'gitlab'"],
      [{ ...RECORDED, repo: 'other-repo' }, 'acme/other-repo'],
    ] as const) {
      const lines: string[] = []
      await fileReporterIssue({
        api: api({
          read: async () => {
            throw new Error('a mismatched record must not be READ against this target')
          },
        }),
        provider: 'github',
        target: TARGET,
        issue: { title: 't', body: 'b' },
        existing,
        journal: journal(lines),
        onRecord: () => {},
      })
      expect(lines.join('\n')).toContain(expected)
    }
  })
})

describe('waiting for the platform to settle the issue', () => {
  it('returns as soon as the issue is closed', async () => {
    const closed = state({ state: 'closed', closed: true, comments: [PR] })
    const settled = await waitForIssueSettled({
      api: api({ read: async () => closed }),
      target: TARGET,
      number: 7,
      journal: journal(),
      budgetMs: 1000,
    })
    expect(settled).toEqual(closed)
  })

  it('states what it last saw when the budget expires, not just the duration', async () => {
    // The rule `deadline.ts` exists for: "open, 1 comment(s)" separates a writeback that commented
    // and did not close from one that never ran at all, and nothing else does.
    await expect(
      waitForIssueSettled({
        api: api({ read: async () => state({ comments: [PR] }) }),
        target: TARGET,
        number: 7,
        journal: journal(),
        budgetMs: 1,
      }),
    ).rejects.toThrow(/open, 1 comment\(s\)/)
  })

  it('fails fast when the issue is deleted mid-wait rather than waiting out the budget', async () => {
    // Nothing the platform does deletes an issue, so this is a person, and waiting would report it
    // as a writeback that never fired.
    await expect(
      waitForIssueSettled({
        api: api({ read: async () => null }),
        target: TARGET,
        number: 7,
        journal: journal(),
        budgetMs: 60_000,
      }),
    ).rejects.toThrow(/no longer exists/)
  })
})

describe('grading what the platform did to the issue', () => {
  const grade = (input: Parameters<typeof checkIssueWriteback>[0]) =>
    Object.fromEntries(checkIssueWriteback(input).map((entry) => [entry.claim, entry]))

  it('passes a closed issue carrying the platform’s comments from both edges', async () => {
    const checks = grade({
      state: state({
        state: 'closed',
        closed: true,
        comments: [`🔧 A pull request was opened for this issue: ${PR}`, `✅ merged: ${PR}`],
      }),
      pullRequestUrl: PR,
    })
    expect(Object.values(checks).every((entry) => entry.ok)).toBe(true)
  })

  it('refuses a closed issue with only ONE comment, which a keyword close cannot be told from', async () => {
    const checks = grade({
      state: state({ state: 'closed', closed: true, comments: [`opened: ${PR}`] }),
      pullRequestUrl: PR,
    })
    const [closed, wrote] = Object.values(checks)
    expect(closed?.ok).toBe(true)
    expect(wrote?.ok).toBe(false)
    expect(wrote?.detail).toContain('1 distinct comment')
  })

  it('counts DISTINCT bodies, so a redelivered comment is not two edges', async () => {
    const duplicate = `🔧 A pull request was opened for this issue: ${PR}`
    const checks = grade({
      state: state({ state: 'closed', closed: true, comments: [duplicate, duplicate] }),
      pullRequestUrl: PR,
    })
    expect(Object.values(checks)[1]?.ok).toBe(false)
  })

  it('ignores comments that do not name this run’s pull request', async () => {
    const checks = grade({
      state: state({
        state: 'closed',
        closed: true,
        comments: ['a human said something', `merged: ${PR}`],
      }),
      pullRequestUrl: PR,
    })
    expect(Object.values(checks)[1]?.ok).toBe(false)
  })

  it('reports an open issue as the failure it is, with the comment count beside it', async () => {
    const checks = grade({ state: state({ comments: [PR] }), pullRequestUrl: PR })
    const [closed] = Object.values(checks)
    expect(closed?.ok).toBe(false)
    expect(closed?.detail).toContain('state=open')
  })

  it('says a missing pull request URL is a GAP in what was observed, not a failed writeback', async () => {
    // Degrade loudly: with no PR recorded there is nothing a comment could be tied to, and claiming
    // the writeback failed would blame the platform for the ledger's gap.
    const checks = grade({
      state: state({ state: 'closed', closed: true, comments: ['something'] }),
      pullRequestUrl: null,
    })
    expect(Object.values(checks)[1]?.detail).toContain('gap in what was observed')
  })
})
