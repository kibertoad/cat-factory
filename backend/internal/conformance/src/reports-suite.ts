import type { ReportRange, ReportScope, ReportsRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the usage-analytics rollups behind the Reports view. Each
// facade aggregates in its own SQL dialect (D1/SQLite vs Postgres) over the SAME five
// tables, so this suite seeds identical rows through a runtime-provided raw seed seam (the
// repository is read-only) and asserts the aggregates agree — a GROUP BY built differently,
// a join that drops unattributed rows, a metered/subscription split that leaks, or an
// off-by-one window bound fails a test instead of shipping. Every case uses a UNIQUE
// account id so the account-scoped queries stay isolated on a shared database.

/** One `token_usage` row to seed. */
export interface ReportsSeedUsage {
  id: string
  workspaceId: string
  /** The run this call belongs to (joins to `agent_runs.id`); null ⇒ unattributed. */
  executionId: string | null
  agentKind: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  costEstimate: number
  billing: 'metered' | 'subscription'
  createdAt: number
}

/** One `agent_runs` row to seed. */
export interface ReportsSeedRun {
  workspaceId: string
  id: string
  status: string
  createdAt: number
  updatedAt: number
  /** `agent_runs.kind`; defaults to `execution`. Activity counts every kind (see the port). */
  kind?: string
  /** The account-owned service the run targets; null ⇒ unattributed. */
  serviceId?: string | null
  /** The block the run targets, resolved for the `taskType` dimension; null ⇒ unattributed. */
  blockId?: string | null
}

/** Raw seed seam a runtime implements against its real store (no domain write path needed). */
export interface ReportsSeed {
  /** Insert a workspace owned by `accountId` (idempotent per id). */
  workspace(id: string, accountId: string, name: string): Promise<void>
  /** Insert a `blocks` row carrying a title and (optionally) a task type. */
  block(workspaceId: string, id: string, title: string, taskType: string | null): Promise<void>
  /**
   * Insert a `services` row pointing at its frame block (the service's display name), and
   * optionally at the provider repo id the `repo` dimension keys on.
   */
  service(
    id: string,
    accountId: string,
    frameBlockId: string,
    repoGithubId?: number | null,
  ): Promise<void>
  /** Insert a `github_repos` projection row (the `repo` dimension's LABEL source). */
  repo(workspaceId: string, githubId: number, owner: string, name: string): Promise<void>
  /** Insert a `tasks` row linked to a block (the `ticket` dimension's key source). */
  ticket(row: ReportsSeedTicket): Promise<void>
  run(row: ReportsSeedRun): Promise<void>
  usage(row: ReportsSeedUsage): Promise<void>
}

/** One `tasks` row to seed: an imported tracker issue linked to a board block. */
export interface ReportsSeedTicket {
  workspaceId: string
  source: string
  externalId: string
  title: string
  /** The block this ticket is linked to: what the `ticket` dimension joins a run through. */
  linkedBlockId: string
}

/** The unique ids one fixture instance is built from (see `defineReportsSuite`). */
export interface FixtureIds {
  account: string
  ws: string
  tag: string
}

/**
 * A workspace whose runs and calls cover both services, both task types, both billing
 * kinds, and the unattributed bucket, plus a second workspace on the SAME account and a
 * third on ANOTHER account, so scoping is exercised by every assertion below.
 */
export async function seedReportsFixture(
  seed: ReportsSeed,
  ids: () => FixtureIds,
  range: ReportRange,
) {
  const { account, ws, tag } = ids()
  const wsB = `${ws}-b`
  const other = ids()
  await seed.workspace(ws, account, 'Board A')
  await seed.workspace(wsB, account, 'Board B')
  await seed.workspace(other.ws, other.account, 'Foreign')

  // Two services, each named by its frame block; two feature tasks with distinct types.
  const frameOne = `frame-1-${tag}`
  const frameTwo = `frame-2-${tag}`
  const svcOne = `svc-1-${tag}`
  const svcTwo = `svc-2-${tag}`
  const taskOne = `task-1-${tag}`
  const taskTwo = `task-2-${tag}`
  await seed.block(ws, frameOne, 'Checkout', null)
  await seed.block(wsB, frameTwo, 'Billing', null)
  // A SECOND board of the same account carrying the SAME frame block id. Block ids are
  // only unique within a workspace (which is why the services↔frame unique index is
  // account-scoped), so a seeded/templated board legitimately collides like this. Every
  // `service` assertion below is therefore also a fan-out guard: resolving the label by
  // joining `blocks` straight from the aggregate would match both rows and DOUBLE this
  // service's calls, tokens and cost. Same title, so the label stays deterministic
  // whichever colliding row the pre-aggregation happens to pick.
  await seed.block(wsB, frameOne, 'Checkout', null)
  // svcOne is linked to a repo; svcTwo deliberately is NOT, so the repo breakdown has a
  // real unattributed bucket rather than only fully-linked services.
  const repoId = 4_242
  const frameThree = `frame-3-${tag}`
  const svcThree = `svc-3-${tag}`
  await seed.block(wsB, frameThree, 'Checkout Admin', null)
  await seed.service(svcOne, account, frameOne, repoId)
  await seed.service(svcTwo, account, frameTwo)
  // A THIRD service pointing at the SAME repository as svcOne, on the other board: the
  // monorepo shape, and the reason `repo` is an activity axis of its own. Its runs fold into
  // svcOne's repository slice, which nothing reading the service breakdown could do for
  // itself (no read publishes the service-to-repository map).
  await seed.service(svcThree, account, frameThree, repoId)
  // The projection row exists on board A only, so the repository's runs on board B resolve
  // their LABEL from the board that does hold it, and an unsynced board keeps its runs.
  await seed.repo(ws, repoId, 'acme', 'checkout')
  await seed.block(ws, taskOne, 'Add coupon', 'feature')
  await seed.block(wsB, taskTwo, 'Fix rounding', 'bug')
  // Two tickets linked to the SAME block: legitimate (two trackers, or a re-import), and
  // the fan-out guard for the ticket dimension. Joining `tasks` straight into the
  // aggregate would double this block's calls, tokens and cost; the lowest ref
  // (`jira:AAA-1`) wins deterministically instead.
  await seed.ticket({
    workspaceId: ws,
    source: 'jira',
    externalId: 'AAA-1',
    title: 'Add coupon',
    linkedBlockId: taskOne,
  })
  await seed.ticket({
    workspaceId: ws,
    source: 'jira',
    externalId: 'ZZZ-9',
    title: 'Duplicate of AAA-1',
    linkedBlockId: taskOne,
  })

  // Runs: one done + one failed on board A (service one), one running on board B.
  await seed.run({
    workspaceId: ws,
    id: `run-a1-${tag}`,
    status: 'done',
    createdAt: 2_000,
    updatedAt: 2_400,
    serviceId: svcOne,
    blockId: taskOne,
  })
  await seed.run({
    workspaceId: ws,
    id: `run-a2-${tag}`,
    status: 'failed',
    createdAt: 3_000,
    updatedAt: 3_600,
    serviceId: svcOne,
    blockId: taskOne,
  })
  await seed.run({
    workspaceId: wsB,
    id: `run-b1-${tag}`,
    status: 'running',
    createdAt: 4_000,
    updatedAt: 4_100,
    serviceId: svcTwo,
    blockId: taskTwo,
  })
  await seed.run({
    workspaceId: wsB,
    id: `run-b2-${tag}`,
    status: 'done',
    createdAt: 4_200,
    updatedAt: 4_400,
    serviceId: svcThree,
    blockId: taskTwo,
  })
  // Outside the window (at `until`, which is exclusive) → excluded everywhere.
  await seed.run({
    workspaceId: ws,
    id: `run-late-${tag}`,
    status: 'done',
    createdAt: range.until,
    updatedAt: range.until,
    serviceId: svcOne,
    blockId: taskOne,
  })
  // A repo BOOTSTRAP on board A: a different `agent_runs.kind`, with no service and no
  // block. Counted like any other run (its LLM calls are in the ledger the spend half
  // reports), and unattributed on the service/task-type axes because it truly is.
  await seed.run({
    workspaceId: ws,
    id: `run-boot-${tag}`,
    kind: 'bootstrap',
    status: 'done',
    createdAt: 2_600,
    updatedAt: 2_800,
  })
  // Another account's run → never visible under this account's scope.
  await seed.run({
    workspaceId: other.ws,
    id: `run-x-${tag}`,
    status: 'done',
    createdAt: 2_000,
    updatedAt: 2_100,
  })

  // Calls: two metered on run a1, one metered on run b1, one subscription on run a2,
  // and one whose run cannot be resolved (the unattributed bucket).
  await seed.usage({
    id: `tok-1-${tag}`,
    workspaceId: ws,
    executionId: `run-a1-${tag}`,
    agentKind: 'coder',
    provider: 'anthropic',
    model: 'sonnet',
    inputTokens: 100,
    outputTokens: 10,
    costEstimate: 2,
    billing: 'metered',
    createdAt: 2_100,
  })
  await seed.usage({
    id: `tok-2-${tag}`,
    workspaceId: ws,
    executionId: `run-a1-${tag}`,
    agentKind: 'coder',
    provider: 'anthropic',
    model: 'sonnet',
    inputTokens: 50,
    outputTokens: 5,
    costEstimate: 1,
    billing: 'metered',
    createdAt: 2_200,
  })
  await seed.usage({
    id: `tok-3-${tag}`,
    workspaceId: wsB,
    executionId: `run-b1-${tag}`,
    agentKind: 'tester',
    provider: 'openai',
    model: 'gpt',
    inputTokens: 20,
    outputTokens: 2,
    costEstimate: 0.5,
    billing: 'metered',
    createdAt: 4_050,
  })
  await seed.usage({
    id: `tok-4-${tag}`,
    workspaceId: ws,
    executionId: `run-a2-${tag}`,
    agentKind: 'coder',
    provider: 'claude-code',
    model: 'opus',
    inputTokens: 7,
    outputTokens: 3,
    costEstimate: 99,
    billing: 'subscription',
    createdAt: 3_100,
  })
  await seed.usage({
    id: `tok-5-${tag}`,
    workspaceId: ws,
    executionId: null,
    agentKind: 'merger',
    provider: 'anthropic',
    model: 'haiku',
    inputTokens: 1,
    outputTokens: 1,
    costEstimate: 0.25,
    billing: 'metered',
    createdAt: 2_500,
  })
  // Before the window → excluded everywhere.
  await seed.usage({
    id: `tok-old-${tag}`,
    workspaceId: ws,
    executionId: `run-a1-${tag}`,
    agentKind: 'coder',
    provider: 'anthropic',
    model: 'sonnet',
    inputTokens: 999,
    outputTokens: 999,
    costEstimate: 999,
    billing: 'metered',
    createdAt: range.since - 1,
  })
  return { account, ws, wsB, svcOne, svcTwo, svcThree, repoId, tag, other }
}

export function defineReportsSuite(
  name: string,
  makeRepo: () => ReportsRepository,
  makeSeed: () => ReportsSeed,
): void {
  describe(`[${name}] reports repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { account: `acc-${tag}`, ws: `ws-${tag}`, tag }
    }
    const range: ReportRange = { since: 1_000, until: 10_000 }
    const scopeOf = (accountId: string, workspaceId?: string): ReportScope => ({
      accountId,
      workspaceId: workspaceId ?? null,
    })
    const byKey = <T extends { key: string }>(rows: T[]) => new Map(rows.map((r) => [r.key, r]))
    /** Seed the shared fixture (module-level, so the suite body stays under its size budget). */
    const seedFixture = () => seedReportsFixture(makeSeed(), ids, range)

    it('groups spend by model, summing tokens and calls within the window', async () => {
      const repo = makeRepo()
      const { account } = await seedFixture()
      const rows = byKey(await repo.spendByDimension(scopeOf(account), 'model', range))
      expect(rows.get('anthropic:sonnet')).toMatchObject({
        inputTokens: 150,
        outputTokens: 15,
        calls: 2,
        meteredCost: 3,
        subscriptionCost: 0,
      })
      expect(rows.get('openai:gpt')).toMatchObject({ calls: 1, meteredCost: 0.5 })
      expect(rows.get('anthropic:haiku')).toMatchObject({ calls: 1, meteredCost: 0.25 })
      // The pre-window row is excluded, so `sonnet` never sees the 999s above.
      expect(rows.get('anthropic:sonnet')?.inputTokens).toBe(150)
    })

    it('keeps subscription cost out of metered cost', async () => {
      // Only `meteredCost` is real money; a split that leaked would report a flat-rate
      // quota harness call as spend and, downstream, as budget.
      const repo = makeRepo()
      const { account } = await seedFixture()
      const rows = byKey(await repo.spendByDimension(scopeOf(account), 'model', range))
      expect(rows.get('claude-code:opus')).toMatchObject({
        meteredCost: 0,
        subscriptionCost: 99,
        calls: 1,
      })
    })

    it('groups spend by REPO, labelling it owner/name and bucketing unlinked services', async () => {
      const repo = makeRepo()
      const { account, repoId } = await seedFixture()
      const rows = byKey(await repo.spendByDimension(scopeOf(account), 'repo', range))
      // The two calls on run a1 (service one, repo-linked) plus the subscription call on a2.
      expect(rows.get(String(repoId))).toMatchObject({
        calls: 3,
        meteredCost: 3,
        subscriptionCost: 99,
        label: 'acme/checkout',
      })
      // Service two has no repo, and the run-less call has no service: both are unattributed,
      // which is a real bucket rather than a dropped row.
      expect(rows.get('')).toMatchObject({ calls: 2, meteredCost: 0.75 })
    })

    it('groups spend by TICKET without fanning out a block linked to several tickets', async () => {
      const repo = makeRepo()
      const { account } = await seedFixture()
      const rows = byKey(await repo.spendByDimension(scopeOf(account), 'ticket', range))
      // Three calls landed on the doubly-linked block's runs. Fanned out they would read as
      // six, and the breakdown would no longer sum to the window's totals.
      expect(rows.get('jira:AAA-1')).toMatchObject({
        calls: 3,
        meteredCost: 3,
        subscriptionCost: 99,
      })
      // The losing ref of a multi-linked block gets its own row only if it is fanning out.
      expect(rows.has('jira:ZZZ-9')).toBe(false)
      // The ticket ref is self-describing, so the dimension reports no label (like `model`).
      expect(rows.get('jira:AAA-1')?.label).toBeNull()
      // Calls on runs with no linked ticket, and the run-less call: unattributed.
      expect(rows.get('')).toMatchObject({ calls: 2, meteredCost: 0.75 })
    })

    it('groups spend by RUN, labelled by the block the run targets', async () => {
      // The finest TCO axis. The key comes off the ledger row itself, so it needs no join to
      // be right; the join is the LABEL's, and a run with no block (a bootstrap) keeps its
      // money and loses its name rather than dropping out.
      const repo = makeRepo()
      const { account, tag } = await seedFixture()
      const rows = byKey(await repo.spendByDimension(scopeOf(account), 'run', range))
      expect(rows.get(`run-a1-${tag}`)).toMatchObject({
        calls: 2,
        meteredCost: 3,
        label: 'Add coupon',
      })
      expect(rows.get(`run-a2-${tag}`)).toMatchObject({ calls: 1, subscriptionCost: 99 })
      // The call whose run cannot be resolved is a real slice, not a dropped row.
      expect(rows.get('')).toMatchObject({ calls: 1, meteredCost: 0.25, label: null })
    })

    it('groups spend by agent kind', async () => {
      const repo = makeRepo()
      const { account } = await seedFixture()
      const rows = byKey(await repo.spendByDimension(scopeOf(account), 'agentKind', range))
      expect(rows.get('coder')).toMatchObject({ calls: 3, meteredCost: 3, subscriptionCost: 99 })
      expect(rows.get('tester')).toMatchObject({ calls: 1 })
      expect(rows.get('merger')).toMatchObject({ calls: 1 })
    })

    it('groups spend by workspace and resolves the board name as the label', async () => {
      const repo = makeRepo()
      const { account, ws, wsB } = await seedFixture()
      const rows = byKey(await repo.spendByDimension(scopeOf(account), 'workspace', range))
      expect(rows.get(ws)).toMatchObject({ label: 'Board A', calls: 4 })
      expect(rows.get(wsB)).toMatchObject({ label: 'Board B', calls: 1 })
      expect(rows.has('Foreign')).toBe(false)
    })

    it('groups spend by service through the run, labelled by the frame title', async () => {
      const repo = makeRepo()
      const { account, svcOne, svcTwo } = await seedFixture()
      const rows = byKey(await repo.spendByDimension(scopeOf(account), 'service', range))
      expect(rows.get(svcOne)).toMatchObject({ label: 'Checkout', calls: 3 })
      expect(rows.get(svcTwo)).toMatchObject({ label: 'Billing', calls: 1 })
    })

    it('never multiplies a service slice when boards share a frame block id', async () => {
      // The explicit statement of what the shared `frameOne` in the fixture guards. A
      // fan-out here does not fail loudly: it silently inflates one slice, so the service
      // breakdown stops summing to the same window totals every other breakdown reports.
      const repo = makeRepo()
      const { account, svcOne } = await seedFixture()
      const model = await repo.spendByDimension(scopeOf(account), 'model', range)
      const service = await repo.spendByDimension(scopeOf(account), 'service', range)
      const calls = (rows: { calls: number }[]) => rows.reduce((sum, r) => sum + r.calls, 0)
      expect(calls(service)).toBe(calls(model))
      expect(byKey(service).get(svcOne)).toMatchObject({ label: 'Checkout', calls: 3 })
      const activity = byKey(await repo.activityByDimension(scopeOf(account), 'service', range))
      expect(activity.get(svcOne)).toMatchObject({ label: 'Checkout', runs: 2 })
    })

    it('buckets a call with no resolvable run as unattributed rather than dropping it', async () => {
      // The `''` key is a real bucket: a report that silently omitted these rows would
      // under-report total spend while looking complete.
      const repo = makeRepo()
      const { account } = await seedFixture()
      const service = byKey(await repo.spendByDimension(scopeOf(account), 'service', range))
      const taskType = byKey(await repo.spendByDimension(scopeOf(account), 'taskType', range))
      expect(service.get('')).toMatchObject({ calls: 1, meteredCost: 0.25 })
      expect(taskType.get('')).toMatchObject({ calls: 1, meteredCost: 0.25 })
    })

    it('groups spend by task type through the run block', async () => {
      const repo = makeRepo()
      const { account } = await seedFixture()
      const rows = byKey(await repo.spendByDimension(scopeOf(account), 'taskType', range))
      expect(rows.get('feature')).toMatchObject({ calls: 3, meteredCost: 3, subscriptionCost: 99 })
      expect(rows.get('bug')).toMatchObject({ calls: 1, meteredCost: 0.5 })
    })

    it('narrows every breakdown to a single workspace when one is given', async () => {
      const repo = makeRepo()
      const { account, ws, wsB } = await seedFixture()
      const rows = byKey(await repo.spendByDimension(scopeOf(account, wsB), 'workspace', range))
      expect([...rows.keys()]).toEqual([wsB])
      expect(rows.get(ws)).toBeUndefined()
    })

    it('never reads another account, even when a foreign workspace id is passed as the filter', async () => {
      // The account scope is applied in SQL, so the filter can only narrow WITHIN it.
      const repo = makeRepo()
      const { account, other } = await seedFixture()
      const rows = await repo.spendByDimension(scopeOf(account, other.ws), 'model', range)
      expect(rows).toEqual([])
    })

    it('orders spend slices heaviest-first', async () => {
      const repo = makeRepo()
      const { account } = await seedFixture()
      const rows = await repo.spendByDimension(scopeOf(account), 'model', range)
      const totals = rows.map((r) => r.meteredCost + r.subscriptionCost)
      expect([...totals].sort((a, b) => b - a)).toEqual(totals)
    })

    it('splits run activity by status and averages only terminal durations', async () => {
      const repo = makeRepo()
      const { account, ws, wsB } = await seedFixture()
      const rows = byKey(await repo.activityByDimension(scopeOf(account), 'workspace', range))
      expect(rows.get(ws)).toMatchObject({
        label: 'Board A',
        // The two pipeline runs plus the bootstrap — every kind counts (see the port doc).
        runs: 3,
        done: 2,
        failed: 1,
        running: 0,
        other: 0,
        // (400 + 600 + 200) / 3 — the out-of-window run never enters the average.
        avgDurationMs: 400,
      })
      // Board B: the running run plus the shared-repository service's done run (200ms).
      expect(rows.get(wsB)).toMatchObject({ runs: 2, running: 1, done: 1, avgDurationMs: 200 })
    })

    it('groups run activity by service and task type', async () => {
      const repo = makeRepo()
      const { account, svcOne, svcTwo } = await seedFixture()
      const services = byKey(await repo.activityByDimension(scopeOf(account), 'service', range))
      const taskTypes = byKey(await repo.activityByDimension(scopeOf(account), 'taskType', range))
      expect(services.get(svcOne)).toMatchObject({ label: 'Checkout', runs: 2 })
      expect(services.get(svcTwo)).toMatchObject({ label: 'Billing', runs: 1 })
      expect(taskTypes.get('feature')).toMatchObject({ runs: 2, done: 1, failed: 1 })
      expect(taskTypes.get('bug')).toMatchObject({ runs: 2, running: 1, done: 1 })
      // The bootstrap run has neither, so it lands in the unattributed slice of both.
      expect(services.get('')).toMatchObject({ runs: 1 })
      expect(taskTypes.get('')).toMatchObject({ runs: 1 })
    })

    it('groups run activity by REPOSITORY, folding every service that points at one', async () => {
      // The axis exists because this fold is not derivable from the service breakdown: two
      // of the account's services point at the same repository, and no read publishes that
      // mapping for a caller to sum the counts itself.
      const repo = makeRepo()
      const { account, repoId } = await seedFixture()
      const rows = byKey(await repo.activityByDimension(scopeOf(account), 'repo', range))
      expect(rows.get(String(repoId))).toMatchObject({
        label: 'acme/checkout',
        // svcOne's done + failed runs on board A, plus svcThree's done run on board B.
        runs: 3,
        done: 2,
        failed: 1,
        // (400 + 600 + 200) / 3, over the slice's terminal runs.
        avgDurationMs: 400,
      })
      // Two different causes land in the same real bucket: a run under a service with no
      // repository, and a bootstrap that has no service at all.
      expect(rows.get('')).toMatchObject({ runs: 2 })
    })

    it('counts every run kind, not just task pipelines', async () => {
      // Activity sits beside spend on the same dimension, and spend is the ledger of the
      // calls these same runs made — so restricting activity to `execution` would put the
      // two halves of one row on different populations.
      const repo = makeRepo()
      const { account, ws } = await seedFixture()
      const rows = byKey(await repo.activityByDimension(scopeOf(account, ws), 'workspace', range))
      expect(rows.get(ws)?.runs).toBe(3)
    })

    it('buckets spend into contiguous time slices, oldest first', async () => {
      const repo = makeRepo()
      const { account } = await seedFixture()
      const buckets = await repo.spendTrend(scopeOf(account), range, 1_000)
      expect(buckets.map((b) => b.bucketStart)).toEqual([2_000, 3_000, 4_000])
      const first = buckets[0]
      expect(first).toMatchObject({ calls: 3, meteredCost: 3.25, subscriptionCost: 0 })
      expect(buckets[1]).toMatchObject({ calls: 1, meteredCost: 0, subscriptionCost: 99 })
      expect(buckets[2]).toMatchObject({ calls: 1, meteredCost: 0.5 })
    })

    it('lands every bucket on a multiple of the bucket width', async () => {
      // Integer (floor) division, not float: SQLite binds JS numbers as REAL, so a bare
      // division would produce bucket starts that never sit on an edge.
      const repo = makeRepo()
      const { account } = await seedFixture()
      const buckets = await repo.spendTrend(scopeOf(account), range, 2_000)
      for (const bucket of buckets) expect(bucket.bucketStart % 2_000).toBe(0)
    })

    it('returns nothing for an account with no rows', async () => {
      const repo = makeRepo()
      const { account } = ids()
      expect(await repo.spendByDimension(scopeOf(account), 'model', range)).toEqual([])
      expect(await repo.activityByDimension(scopeOf(account), 'service', range)).toEqual([])
      expect(await repo.spendTrend(scopeOf(account), range, 1_000)).toEqual([])
    })
  })
}
