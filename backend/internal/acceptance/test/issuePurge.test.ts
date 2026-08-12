import { describe, expect, it } from 'vitest'
import {
  applyIssuePurge,
  issuePurgeSucceeded,
  planIssuePurge,
  type LedgerIssue,
} from '../src/issuePurge.ts'
import type { IssueApi, OpenIssueSummary } from '../src/vcsIssues.ts'

// What is pinned here is that DISCOVERY cannot close somebody's real issue. A purge that closed by
// title alone would settle a maintainer's issue quoting this suite's; by author alone it would settle
// anything the reporter account ever filed on a fixture repository. Only the PAIR is a fingerprint,
// and everything failing it has to be reported as skipped rather than passed over, because "we saw it
// and left it" and "we never looked" are different facts about a board about to be re-run against.

const backend = { owner: 'acme', repo: 'catalog-api' }
const KNOWN = 'GET /items silently ignores a non-numeric offset instead of rejecting it'

type Closed = { repo: string; number: number }

function api(overrides: Partial<IssueApi> = {}): IssueApi & { closed: Closed[] } {
  const closed: Closed[] = []
  const base: IssueApi = {
    probe: async () => ({ status: 'ready' }),
    file: async () => ({ number: 0, url: '' }),
    read: async () => ({ state: 'open', closed: false, url: 'u', comments: [] }),
    listOpen: async () => [],
    close: async (target, number) => void closed.push({ repo: target.repo, number }),
    viewer: async () => 'acceptance-bot',
  }
  return { ...base, ...overrides, closed }
}

function open(overrides: Partial<OpenIssueSummary> = {}): OpenIssueSummary {
  return {
    number: 11,
    title: KNOWN,
    url: 'https://github.com/acme/catalog-api/issues/11',
    authorLogin: 'acceptance-bot',
    ...overrides,
  }
}

const ledgerIssue: LedgerIssue = {
  runId: '20260812080000',
  target: backend,
  number: 1,
  url: 'https://github.com/acme/catalog-api/issues/1',
}

async function plan(
  client: IssueApi,
  ledgerIssues: readonly LedgerIssue[] = [],
  keptIssues: readonly LedgerIssue[] = [],
) {
  return planIssuePurge(client, {
    targets: [backend],
    ledgerIssues,
    keptIssues,
    knownTitles: [KNOWN],
  })
}

describe('planIssuePurge', () => {
  it('takes an issue a ledger names without needing to discover it', async () => {
    const result = await plan(api(), [ledgerIssue])
    expect(result.close).toHaveLength(1)
    expect(result.close[0]).toMatchObject({
      number: 1,
      found: 'named-by-pass',
      runId: ledgerIssue.runId,
    })
  })

  it('discovers one filed by this credential under a title this suite files', async () => {
    const result = await plan(api({ listOpen: async () => [open()] }))
    expect(result.close.map((issue) => issue.number)).toEqual([11])
    expect(result.close[0]?.found).toBe('discovered')
    expect(result.skipped).toEqual([])
  })

  it('leaves an issue with the right title filed by somebody else, and says why', async () => {
    const result = await plan(api({ listOpen: async () => [open({ authorLogin: 'a-human' })] }))
    expect(result.close).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.reason).toContain('a-human')
  })

  it('leaves an issue filed by this credential under a title it does not file', async () => {
    const result = await plan(api({ listOpen: async () => [open({ title: 'Please add auth' })] }))
    expect(result.close).toEqual([])
    expect(result.skipped[0]?.reason).toContain('not one this suite files')
  })

  // An unreadable viewer disables the author half, so the PAIR can no longer be met. Closing on the
  // title alone here would be the exact accident this test exists against.
  it('discovers nothing when the reporter account cannot be read, and says so', async () => {
    const result = await plan(
      api({
        listOpen: async () => [open()],
        viewer: async () => {
          throw new Error('401')
        },
      }),
    )
    expect(result.close).toEqual([])
    expect(result.problems).toHaveLength(1)
    expect(result.skipped[0]?.reason).toContain('authorship could not be confirmed')
  })

  // A ledger is evidence of authorship on its own, so it survives a failure that only disables
  // discovery: the pass recorded filing that exact issue.
  it('still closes a ledger-named issue when the viewer read failed', async () => {
    const result = await plan(
      api({
        viewer: async () => {
          throw new Error('401')
        },
      }),
      [ledgerIssue],
    )
    expect(result.close.map((issue) => issue.number)).toEqual([1])
  })

  it('reports an unreadable issue list rather than reading it as no issues', async () => {
    const result = await plan(
      api({
        listOpen: async () => {
          throw new Error('403')
        },
      }),
    )
    expect(result.problems[0]).toContain('still open')
    expect(issuePurgeSucceeded({ ...empty(), problems: result.problems })).toBe(false)
  })

  // The exclusion cannot be derived here: a kept pass's issue wears the same title and the same
  // author as a removed pass's, which is the whole fingerprint discovery works from. Closing it
  // would settle the spec-04 gate of the one pass the reset went out of its way to leave resumable.
  it('leaves an issue belonging to a pass whose files are kept, and names that pass', async () => {
    const kept = { ...ledgerIssue, runId: '20260812090000', number: 11 }
    const result = await plan(api({ listOpen: async () => [open()] }), [], [kept])
    expect(result.close).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.reason).toContain('20260812090000')
    expect(result.skipped[0]?.reason).toContain('resumed')
  })

  it('does not list a ledger-named issue twice when discovery finds it too', async () => {
    const result = await plan(api({ listOpen: async () => [open({ number: 1 })] }), [ledgerIssue])
    expect(result.close).toHaveLength(1)
    expect(result.skipped).toEqual([])
  })
})

describe('applyIssuePurge', () => {
  it('closes what it planned', async () => {
    const client = api()
    const report = await applyIssuePurge(client, await plan(client, [ledgerIssue]))
    expect(client.closed).toEqual([{ repo: 'catalog-api', number: 1 }])
    expect(report.closed).toHaveLength(1)
    expect(issuePurgeSucceeded(report)).toBe(true)
  })

  // The purge wanted it not-open. A resumed attempt or the platform's own writeback getting there
  // first is the state it was aiming for, not an error to send someone chasing.
  it('counts an already-closed issue as settled and does not re-close it', async () => {
    const client = api({
      read: async () => ({ state: 'closed', closed: true, url: 'u', comments: [] }),
    })
    const report = await applyIssuePurge(client, await plan(client, [ledgerIssue]))
    expect(client.closed).toEqual([])
    expect(report.alreadySettled).toHaveLength(1)
    expect(issuePurgeSucceeded(report)).toBe(true)
  })

  it('counts an issue the provider no longer has as settled', async () => {
    const client = api({ read: async () => null })
    const report = await applyIssuePurge(client, await plan(client, [ledgerIssue]))
    expect(report.alreadySettled).toHaveLength(1)
  })

  it('collects a refused close rather than throwing, and fails the purge', async () => {
    const client = api({
      close: async () => {
        throw new Error('issues are locked')
      },
    })
    const report = await applyIssuePurge(client, await plan(client, [ledgerIssue]))
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.detail).toContain('locked')
    expect(issuePurgeSucceeded(report)).toBe(false)
  })
})

function empty() {
  return { closed: [], alreadySettled: [], failed: [], skipped: [], problems: [] }
}
