import type {
  ChangeClass,
  ExecutionInstance,
  MergeClassRollup,
  MergeTrackRecord,
  Pipeline,
  RepoFiles,
  RiskPolicy,
  RunMode,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { CHANGE_CLASSES, type PublicMergeRecord } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from './harness.js'

// Cross-runtime parity for the MERGE TRACK RECORD (backend/docs/adr/0046-merge-track-record.md):
// the deterministic change classification, the per-class auto-merge rules on a merge preset, the
// persisted record of each merge decision, the reviewer-effort tag, and the per-class SQL rollups.
//
// What this proves that a unit test can't: the whole chain is wired on BOTH facades — the
// `merge_track_records` table + its repository (D1 ⇄ Drizzle) map the same columns, the `class_rules`
// preset column round-trips, `MergeResolver` reads the classification through the run-repo seam,
// the notification `act` body's effort tag lands on the record, and the rollup aggregate returns
// the same numbers from SQLite and Postgres. A facade that mapped a column differently, or forgot
// to wire the repository, fails a test here instead of shipping.
//
// Everything is driven over real HTTP against `app.fetch`, with the changed-file list served by a
// fake `RepoFiles` through the SAME `resolveRunRepoContext` override the custom-agent suites use.

/** A `RepoFiles` that reports exactly `paths` as the PR's changed files. */
function repoWithChangedFiles(paths: string[]): RepoFiles {
  return {
    getFile: async () => null,
    listDirectory: async () => [],
    headSha: async () => 'base-sha',
    createBranch: async () => {},
    deleteBranch: async () => {},
    commitFiles: async () => ({ sha: 'commit-sha' }),
    openPullRequest: async () => {
      throw new Error('this suite never opens a PR')
    },
    listChangedFiles: async () =>
      paths.map((path) => ({
        path,
        previousPath: null,
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: null,
      })),
  }
}

/** The PR the fake coder reports, so the block carries a number classification can read. */
const FAKE_PR = { url: 'https://github.test/acme/repo/pull/42', number: 42, branch: 'work' }

/**
 * The provider-neutral repo id the run's repo context resolves to. It is what a record must be
 * ATTRIBUTABLE by: external-merge detection looks a record up by `(repoId, prNumber)`, since a
 * webhook delivery knows nothing else about the run.
 */
const FAKE_REPO_ID = '987654'

/** Drive one merger run to its decision — the shared arrangement every case in this file uses. */
type MergerRunDriver = (options: {
  changedFiles: string[]
  assessment: { complexity: number; risk: number; impact: number; rationale: string }
  /** Created and pinned on the task before the run when supplied. */
  preset?: Record<string, unknown>
  /** Requests a SANDBOXED run at start, exactly as the HTTP contract lets a caller. */
  mode?: RunMode
  /** Places the board in an ORG account, which is what a public-API key can be minted for. */
  org?: boolean
}) => Promise<{
  app: ConformanceApp
  wsId: string
  executionId: string
  status: string
  decision: { outcome?: string; reason?: string; changeClass?: string }
}>

/** The half of a public notification card these cases address: which card, and its record id. */
interface PublicNotificationCard {
  id: string
  type: string
  payload?: { mergeTrackRecordId?: string } | null
}

/** Read back one change class's merge-track rollup. */
type MergeRollupReader = (
  app: ConformanceApp,
  wsId: string,
  changeClass: ChangeClass,
) => Promise<MergeClassRollup>

export function defineMergeTrackRecordSuite(harness: ConformanceHarness): void {
  const { name } = harness

  describe(`[${name}] merge track record (HTTP)`, () => {
    /**
     * Run a `coder` + `merger` pipeline to completion with a given changed-file list, merger
     * assessment and (optionally) a preset carrying per-class rules. Returns everything the
     * assertions need: the settled block, the merger step's recorded decision, and the run id.
     */
    async function driveMergerRun(options: {
      changedFiles: string[]
      assessment: { complexity: number; risk: number; impact: number; rationale: string }
      /** Created and pinned on the task before the run when supplied. */
      preset?: Record<string, unknown>
      /** Requests a SANDBOXED run at start, exactly as the HTTP contract lets a caller. */
      mode?: RunMode
      /** Places the board in an ORG account, which is what a public-API key can be minted for. */
      org?: boolean
    }): Promise<{
      app: ConformanceApp
      wsId: string
      executionId: string
      status: string
      decision: { outcome?: string; reason?: string; changeClass?: string }
    }> {
      const app = harness.makeApp(
        {
          confidence: 1,
          pullRequest: FAKE_PR,
          mergeAssessment: options.assessment,
        },
        {
          resolveRunRepoContext: async () => ({
            repo: repoWithChangedFiles(options.changedFiles),
            baseBranch: 'main',
            repoId: FAKE_REPO_ID,
            provider: 'github' as const,
          }),
        },
      )
      // A public-API key is ACCOUNT-scoped, so the cases that mint one need an org-owned board;
      // everything else keeps the cheaper plain workspace. Both seed the same demo board, so
      // `task_login` and the built-in pipelines are there either way.
      const { workspace } = options.org
        ? await app.createOrgWorkspace({ seed: true })
        : await app.createWorkspace()
      const wsId = workspace.id

      if (options.preset) {
        const created = await app.call<RiskPolicy>('POST', `/workspaces/${wsId}/risk-policies`, {
          name: 'Class rules',
          maxComplexity: 0.5,
          maxRisk: 0.4,
          maxImpact: 0.5,
          ciMaxAttempts: 10,
          maxRequirementIterations: 6,
          maxRequirementConcernAllowed: 'none',
          ...options.preset,
        })
        expect(created.status).toBe(201)
        await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
          riskPolicyId: created.body.id,
        })
      }

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Build + merger',
        purpose: 'build',
        agentKinds: ['coder', 'merger'],
      })
      const start = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id, ...(options.mode ? { mode: options.mode } : {}) },
      )
      expect(start.status).toBe(201)
      const ticked = await app.drive(wsId)
      const exec = ticked.find((e) => e.blockId === 'task_login')!
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      return {
        app,
        wsId,
        executionId: exec.id,
        status: snap.blocks.find((b) => b.id === 'task_login')!.status,
        decision: exec.steps.find((s) => s.agentKind === 'merger')!.custom as {
          outcome?: string
          reason?: string
          changeClass?: string
        },
      }
    }

    const rollupFor = async (
      app: ConformanceApp,
      wsId: string,
      changeClass: ChangeClass,
    ): Promise<MergeClassRollup> => {
      const res = await app.call<MergeClassRollup[]>(
        'GET',
        `/workspaces/${wsId}/merge-track-records/rollups`,
      )
      expect(res.status).toBe(200)
      // The rollup response always carries EVERY class (the service fills empties in), so a
      // never-seen class reads as zeros rather than being absent.
      const found = res.body.find((r) => r.changeClass === changeClass)
      expect(found, `rollup for ${changeClass}`).toBeDefined()
      return found!
    }

    it('records an auto-merge with the run change class and a null effort tag', async () => {
      // The happy path: a within-threshold, credibly-explained assessment auto-merges, and the
      // decision is persisted with the DETERMINISTIC class derived from the changed files — no
      // human has tagged it, so the effort is null and the class's rollup counts it as untagged.
      const run = await driveMergerRun({
        changedFiles: ['src/login.ts', 'README.md'],
        assessment: { complexity: 0.1, risk: 0.1, impact: 0.1, rationale: 'Small, well-tested.' },
      })
      expect(run.status).toBe('done')
      expect(run.decision.outcome).toBe('auto_merged')
      // Mixed diff (source + docs) resolves to the HIGHEST-ranked class present.
      expect(run.decision.changeClass).toBe('source')

      const rollup = await rollupFor(run.app, run.wsId, 'source')
      expect(rollup.total).toBe(1)
      expect(rollup.autoMerged).toBe(1)
      expect(rollup.merged).toBe(1)
      expect(rollup.humanMerged).toBe(0)
      expect(rollup.pendingReview).toBe(0)
      // An auto-merge records itself with NO tag — nothing downstream may break on the null.
      expect(rollup.effort).toEqual({ none: 0, minor: 0, major: 0, untagged: 1 })
    })

    it('classifies a mixed diff by the documented precedence (highest-ranked class wins)', async () => {
      // A dependency bump that also touches a migration is a SCHEMA change: `schema` outranks
      // `dependency`, so an "always auto-merge dependency bumps" rule could never fire on it.
      // This is the property that makes per-class rules safe, so it is asserted on both runtimes.
      const run = await driveMergerRun({
        changedFiles: ['package.json', 'pnpm-lock.yaml', 'drizzle/0001_x/migration.sql'],
        assessment: { complexity: 0.1, risk: 0.1, impact: 0.1, rationale: 'Bump + migration.' },
      })
      expect(run.decision.changeClass).toBe('schema')
      expect((await rollupFor(run.app, run.wsId, 'schema')).total).toBe(1)
      expect((await rollupFor(run.app, run.wsId, 'dependency')).total).toBe(0)
    })

    it('auto-merges an over-threshold dependency bump when the preset always auto-merges that class', async () => {
      // The headline acceptance criterion. The assessment BUSTS every ceiling, so the score
      // comparison alone would raise `merge_review`; the preset's `dependency: always` rule
      // overrides it. Proves the full wiring: `class_rules` persisted on the preset row →
      // `resolveRiskPolicy` → the classification through the run-repo seam → `MergeResolver`.
      const run = await driveMergerRun({
        changedFiles: ['package.json', 'pnpm-lock.yaml'],
        assessment: { complexity: 0.95, risk: 0.95, impact: 0.95, rationale: 'Big bump.' },
        preset: { classRules: { dependency: 'always' } },
      })
      expect(run.status).toBe('done')
      expect(run.decision.outcome).toBe('auto_merged')
      // The reason names the CLASS rule, not the thresholds — the banner must not imply the
      // scores were within range when they plainly were not.
      expect(run.decision.reason).toBe('class_auto_merge')
      expect(run.decision.changeClass).toBe('dependency')
      expect((await rollupFor(run.app, run.wsId, 'dependency')).autoMerged).toBe(1)
    })

    it('forces review on a within-threshold schema change when the preset never auto-merges that class', async () => {
      // The inverse rule. A maximally-mergeable assessment (0/0/0 + a real rationale) would
      // auto-merge under the score comparison; `schema: never` must route it to a human anyway.
      const run = await driveMergerRun({
        changedFiles: ['backend/runtimes/cloudflare/migrations/0099_add_column.sql'],
        assessment: { complexity: 0, risk: 0, impact: 0, rationale: 'One nullable column.' },
        preset: { classRules: { schema: 'never' } },
      })
      expect(run.status).toBe('pr_ready')
      expect(run.status).not.toBe('done')
      expect(run.decision.outcome).toBe('awaiting_review')
      expect(run.decision.reason).toBe('class_requires_review')
      expect(run.decision.changeClass).toBe('schema')
      // Routed to review ⇒ the record is `pending_review`, NOT counted as merged.
      const rollup = await rollupFor(run.app, run.wsId, 'schema')
      expect(rollup.pendingReview).toBe(1)
      expect(rollup.merged).toBe(0)
    })

    it('never lets a class rule override a "manual review only" preset', async () => {
      // Precedence: `autoMergeEnabled: false` is the MASTER switch. A workspace that flips a class
      // to `always` on a manual-review preset must still get a human gate — otherwise the
      // "manual review only" guarantee silently evaporates.
      const run = await driveMergerRun({
        changedFiles: ['docs/guide.md'],
        assessment: { complexity: 0, risk: 0, impact: 0, rationale: 'Typo fix.' },
        preset: { autoMergeEnabled: false, classRules: { docs: 'always' } },
      })
      expect(run.status).toBe('pr_ready')
      expect(run.decision.outcome).toBe('awaiting_review')
      expect(run.decision.reason).toBe('auto_merge_disabled')
    })

    registerMergeEffortTagTests(harness, driveMergerRun, rollupFor)
    registerPublicMergeEvidenceTests(driveMergerRun)
    registerMergeClassFallbackTests(harness, driveMergerRun, rollupFor)
    registerRoleScopedPolicyTests(harness)
    registerDryRunTests(driveMergerRun)
    registerSubmissionAllowlistTests(harness)
  })
}

/**
 * The reviewer-effort tag: recorded when a human confirms from the notification card, from
 * the block route, added later through the record route, or absent when none is supplied —
 * plus the rejection a dismissal records.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerMergeEffortTagTests(
  harness: ConformanceHarness,
  driveMergerRun: MergerRunDriver,
  rollupFor: MergeRollupReader,
): void {
  it('records the reviewer-effort tag when a human confirms the merge from the notification card', async () => {
    // The capture point: acting on the `merge_review` card with a `reviewEffort` merges the PR
    // AND settles the run's record as `human_merged` + tagged, in one request. The card also
    // carries the class + record id so the SPA can render the class's history and tag in place.
    const run = await driveMergerRun({
      changedFiles: ['src/login.ts'],
      assessment: { complexity: 0.9, risk: 0.9, impact: 0.9, rationale: 'Risky refactor.' },
    })
    expect(run.status).toBe('pr_ready')

    const snap = (await run.app.call<WorkspaceSnapshot>('GET', `/workspaces/${run.wsId}`)).body
    const card = snap.notifications?.find((n) => n.type === 'merge_review')
    expect(card, 'merge_review card').toBeDefined()
    expect(card!.payload?.changeClass).toBe('source')
    expect(card!.payload?.mergeTrackRecordId).toBeTruthy()

    const acted = await run.app.call(
      'POST',
      `/workspaces/${run.wsId}/notifications/${card!.id}/act`,
      { reviewEffort: 'none' },
    )
    expect(acted.status).toBe(200)

    const rollup = await rollupFor(run.app, run.wsId, 'source')
    expect(rollup.humanMerged).toBe(1)
    expect(rollup.autoMerged).toBe(0)
    expect(rollup.pendingReview).toBe(0)
    // "Zero blocking comments" is exactly the evidence that would justify widening this class.
    expect(rollup.effort).toEqual({ none: 1, minor: 0, major: 0, untagged: 0 })
  })

  it('merges without a tag when the human supplies none, and tags later through the record route', async () => {
    // Tagging is ZERO-MANDATORY: an untagged act must merge cleanly and leave a null tag, and
    // the standalone effort route must be able to fill it in afterwards (the same route the
    // external-merge nudge and the inspector's merge controls use).
    const run = await driveMergerRun({
      changedFiles: ['src/login.test.ts'],
      assessment: { complexity: 0.9, risk: 0.9, impact: 0.9, rationale: 'Risky.' },
    })
    const snap = (await run.app.call<WorkspaceSnapshot>('GET', `/workspaces/${run.wsId}`)).body
    const card = snap.notifications!.find((n) => n.type === 'merge_review')!
    // No body fields at all — the historical no-tag act.
    const acted = await run.app.call(
      'POST',
      `/workspaces/${run.wsId}/notifications/${card.id}/act`,
      {},
    )
    expect(acted.status).toBe(200)

    const untagged = await rollupFor(run.app, run.wsId, 'test')
    expect(untagged.humanMerged).toBe(1)
    expect(untagged.effort.untagged).toBe(1)

    const tagged = await run.app.call<MergeTrackRecord>(
      'POST',
      `/workspaces/${run.wsId}/merge-track-records/${card.payload!.mergeTrackRecordId}/effort`,
      { reviewEffort: 'major' },
    )
    expect(tagged.status).toBe(200)
    expect(tagged.body.reviewEffort).toBe('major')
    // The decision is untouched by tagging — only the effort moves.
    expect(tagged.body.decision).toBe('human_merged')

    const after = await rollupFor(run.app, run.wsId, 'test')
    expect(after.effort).toEqual({ none: 0, minor: 0, major: 1, untagged: 0 })

    // The record must carry the repo identity it was classified against. This is what makes it
    // ATTRIBUTABLE: external-merge detection can only find a record by `(repoId, prNumber)`,
    // so a record persisted with a null `repoId` is invisible to it on BOTH runtimes — the PR
    // would sit `pending_review` forever and no tag-request nudge would ever be raised.
    expect(tagged.body.repoId).toBe(FAKE_REPO_ID)
    expect(tagged.body.prNumber).toBe(FAKE_PR.number)
    expect(tagged.body.provider).toBe('github')
  })

  it('records the effort tag when a human merges through the BLOCK route (the inspector control)', async () => {
    // The second capture point: `POST /blocks/:id/merge` is block-scoped (no notification in
    // flight), so the record is resolved by BLOCK rather than by run. Asserting it here proves
    // both facades wire that path, not just the notification one.
    const run = await driveMergerRun({
      changedFiles: ['docs/guide.md', 'src/api.ts'],
      assessment: { complexity: 0.9, risk: 0.9, impact: 0.9, rationale: 'Risky.' },
    })
    expect(run.status).toBe('pr_ready')

    const merged = await run.app.call('POST', `/workspaces/${run.wsId}/blocks/task_login/merge`, {
      reviewEffort: 'minor',
    })
    expect(merged.status).toBe(200)
    const snap = (await run.app.call<WorkspaceSnapshot>('GET', `/workspaces/${run.wsId}`)).body
    expect(snap.blocks.find((b) => b.id === 'task_login')!.status).toBe('done')

    const rollup = await rollupFor(run.app, run.wsId, 'source')
    expect(rollup.humanMerged).toBe(1)
    expect(rollup.effort).toEqual({ none: 0, minor: 1, major: 0, untagged: 0 })
  })

  it('records a rejection when the human dismisses the merge card instead of merging', async () => {
    // Without this the record would sit at `pending_review` forever and the class's auto-merge
    // share would be computed against a denominator that never settles.
    const run = await driveMergerRun({
      changedFiles: ['.github/workflows/ci.yml'],
      assessment: { complexity: 0.9, risk: 0.9, impact: 0.9, rationale: 'Risky.' },
    })
    const snap = (await run.app.call<WorkspaceSnapshot>('GET', `/workspaces/${run.wsId}`)).body
    const card = snap.notifications!.find((n) => n.type === 'merge_review')!
    const dismissed = await run.app.call(
      'POST',
      `/workspaces/${run.wsId}/notifications/${card.id}/dismiss`,
    )
    expect(dismissed.status).toBe(200)

    const rollup = await rollupFor(run.app, run.wsId, 'config')
    expect(rollup.rejected).toBe(1)
    expect(rollup.pendingReview).toBe(0)
    expect(rollup.merged).toBe(0)
  })
}

/**
 * The `unknown` change class an unreadable diff yields (which matches no rule, so the score
 * thresholds decide) and the per-class rollups a single request returns.
 *
 * Registered from the suite above; split out purely to keep each function within the
 * per-function line budget. Every test is unchanged.
 */
function registerMergeClassFallbackTests(
  harness: ConformanceHarness,
  driveMergerRun: MergerRunDriver,
  rollupFor: MergeRollupReader,
): void {
  it('classifies as `unknown` and falls back to the score thresholds when no VCS client is wired', async () => {
    // The pass-through guarantee. With no `resolveRunRepoContext` the changed-file list is
    // unavailable, so the class is `unknown` — and `unknown` matches NO rule, so a preset that
    // would otherwise always auto-merge this diff must fall back to the score comparison. This
    // is what keeps a transient VCS outage from silently changing merge policy.
    const app = harness.makeApp({
      confidence: 1,
      pullRequest: FAKE_PR,
      mergeAssessment: { complexity: 0.95, risk: 0.95, impact: 0.95, rationale: 'Risky.' },
    })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const preset = await app.call<RiskPolicy>('POST', `/workspaces/${wsId}/risk-policies`, {
      name: 'Always source',
      maxComplexity: 0.5,
      maxRisk: 0.4,
      maxImpact: 0.5,
      ciMaxAttempts: 10,
      maxRequirementIterations: 6,
      maxRequirementConcernAllowed: 'none',
      classRules: { source: 'always', docs: 'always', unknown: 'always' } as never,
    })
    // `unknown` is not an authorable class, so the request is rejected outright rather than
    // silently storing a rule that could never match.
    expect(preset.status).toBe(400)

    const valid = await app.call<RiskPolicy>('POST', `/workspaces/${wsId}/risk-policies`, {
      name: 'Always source',
      maxComplexity: 0.5,
      maxRisk: 0.4,
      maxImpact: 0.5,
      ciMaxAttempts: 10,
      maxRequirementIterations: 6,
      maxRequirementConcernAllowed: 'none',
      classRules: { source: 'always' },
    })
    expect(valid.status).toBe(201)
    expect(valid.body.classRules).toEqual({ source: 'always' })
    await app.call('PATCH', `/workspaces/${wsId}/blocks/task_login`, {
      riskPolicyId: valid.body.id,
    })
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + merger',
      purpose: 'build',
      agentKinds: ['coder', 'merger'],
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: pipeline.body.id,
    })
    const ticked = await app.drive(wsId)
    const exec = ticked.find((e) => e.blockId === 'task_login')!
    const decision = exec.steps.find((s) => s.agentKind === 'merger')!.custom as {
      outcome?: string
      reason?: string
      changeClass?: string
    }
    // No class ⇒ no rule ⇒ the busted ceilings decide, exactly as before the feature existed.
    expect(decision.changeClass).toBeUndefined()
    expect(decision.outcome).toBe('awaiting_review')
    expect(decision.reason).toBe('exceeded_thresholds')
    const rollup = await rollupFor(app, wsId, 'unknown')
    expect(rollup.pendingReview).toBe(1)
  })

  it('keeps per-class rollups separate and returns every class in one request', async () => {
    // The rollup is ONE SQL aggregate over the whole workspace, so this pins that the GROUP BY
    // partitions correctly (two classes, distinct counts) and that classes with no rows still
    // come back as zeros — the preset editor renders a row per class regardless.
    const app = harness.makeApp(
      {
        confidence: 1,
        pullRequest: FAKE_PR,
        mergeAssessment: { complexity: 0.1, risk: 0.1, impact: 0.1, rationale: 'Trivial.' },
      },
      {
        resolveRunRepoContext: async (_ws, blockId) => ({
          // Classify by which task ran, so one workspace accumulates two different classes.
          repo: repoWithChangedFiles(blockId === 'task_login' ? ['docs/a.md'] : ['src/a.test.ts']),
          baseBranch: 'main',
          repoId: 'repo_1',
        }),
      },
    )
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + merger',
      purpose: 'build',
      agentKinds: ['coder', 'merger'],
    })
    // Two DIFFERENT seeded tasks, so one workspace accumulates two different classes.
    for (const blockId of ['task_login', 'task_refresh']) {
      const started = await app.call('POST', `/workspaces/${wsId}/blocks/${blockId}/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(started.status).toBe(201)
      await app.drive(wsId)
    }

    const res = await app.call<MergeClassRollup[]>(
      'GET',
      `/workspaces/${wsId}/merge-track-records/rollups`,
    )
    expect(res.status).toBe(200)
    const byClass = new Map(res.body.map((r) => [r.changeClass, r]))
    expect(byClass.get('docs')?.autoMerged).toBe(1)
    expect(byClass.get('test')?.autoMerged).toBe(1)
    expect(byClass.get('source')?.total).toBe(0)
    expect(byClass.get('schema')?.total).toBe(0)
    // One response, every class — never one request per class.
    expect(res.body).toHaveLength(7)
  })
}

/**
 * Role-scoped merge policy + the sandboxed run mode, asserted across runtimes.
 *
 * What genuinely differs between D1 and Postgres here is the PERSISTENCE of the two new preset
 * columns — a JSON map and a JSON array, written and read back by two independently-written
 * repositories. The narrowing rule itself is pure kernel logic pinned by unit tests, so what
 * these assert is that a preset authored on either runtime resolves to the same policy.
 *
 * Registered from the suite above; split out to keep each function within the per-function
 * line budget.
 */
function registerRoleScopedPolicyTests(harness: ConformanceHarness): void {
  it('round-trips role-scoped class rules and sandboxed roles on a preset', async () => {
    const app = harness.makeApp({})
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    const created = await app.call<RiskPolicy>('POST', `/workspaces/${wsId}/risk-policies`, {
      name: 'Role scoped',
      maxComplexity: 0.5,
      maxRisk: 0.4,
      maxImpact: 0.5,
      ciMaxAttempts: 10,
      maxRequirementIterations: 6,
      maxRequirementConcernAllowed: 'none',
      classRules: { docs: 'always', dependency: 'always' },
      classRulesByRole: { member: { dependency: 'never' } },
      dryRunRoles: ['viewer'],
      // Two entries with opposite readings on purpose: an EMPTY list is "this role lands
      // nothing", where an ABSENT one (admin, here) is unrestricted. A repository that
      // round-tripped the map through a falsy check would collapse them.
      submissionClassesByRole: { member: ['docs', 'dependency'], viewer: [] },
    })
    expect(created.status).toBe(201)
    expect(created.body.classRulesByRole).toEqual({ member: { dependency: 'never' } })
    expect(created.body.dryRunRoles).toEqual(['viewer'])
    expect(created.body.submissionClassesByRole).toEqual({
      member: ['docs', 'dependency'],
      viewer: [],
    })

    // Read back through a SECOND request, so the assertion covers the repository's row→entity
    // mapping rather than only what the create handler happened to echo.
    const listed = await app.call<RiskPolicy[]>('GET', `/workspaces/${wsId}/risk-policies`)
    expect(listed.status).toBe(200)
    const stored = listed.body.find((p) => p.id === created.body.id)
    expect(stored?.classRulesByRole).toEqual({ member: { dependency: 'never' } })
    expect(stored?.dryRunRoles).toEqual(['viewer'])
    expect(stored?.submissionClassesByRole).toEqual({
      member: ['docs', 'dependency'],
      viewer: [],
    })
  })

  it('rejects a role-scoped rule authored for the unruleable `unknown` class', async () => {
    // The same invariant the base map carries, one tier in: an unreadable diff must fall back to
    // the score thresholds, so no rule may be authored against `unknown` — at either tier.
    const app = harness.makeApp({})
    const { workspace } = await app.createWorkspace()
    const res = await app.call<RiskPolicy>('POST', `/workspaces/${workspace.id}/risk-policies`, {
      name: 'Bad role rule',
      maxComplexity: 0.5,
      maxRisk: 0.4,
      maxImpact: 0.5,
      ciMaxAttempts: 10,
      maxRequirementIterations: 6,
      maxRequirementConcernAllowed: 'none',
      classRulesByRole: { member: { unknown: 'always' } } as never,
    })
    expect(res.status).toBe(400)
  })

  it('rejects a submission allowlist naming the unruleable `unknown` class', async () => {
    // Same invariant, third tier: an allowlist that could name `unknown` would let an operator
    // author a policy about a diff nobody could read.
    const app = harness.makeApp({})
    const { workspace } = await app.createWorkspace()
    const res = await app.call<RiskPolicy>('POST', `/workspaces/${workspace.id}/risk-policies`, {
      name: 'Bad allowlist',
      maxComplexity: 0.5,
      maxRisk: 0.4,
      maxImpact: 0.5,
      ciMaxAttempts: 10,
      maxRequirementIterations: 6,
      maxRequirementConcernAllowed: 'none',
      submissionClassesByRole: { member: ['unknown'] } as never,
    })
    expect(res.status).toBe(400)
  })

  it('defaults both to empty on a preset that authors neither', async () => {
    // The identity that keeps every pre-existing preset on exactly its previous behaviour: no
    // role narrows anything, nobody is sandboxed.
    const app = harness.makeApp({})
    const { workspace } = await app.createWorkspace()
    const res = await app.call<RiskPolicy>('POST', `/workspaces/${workspace.id}/risk-policies`, {
      name: 'Plain',
      maxComplexity: 0.5,
      maxRisk: 0.4,
      maxImpact: 0.5,
      ciMaxAttempts: 10,
      maxRequirementIterations: 6,
      maxRequirementConcernAllowed: 'none',
    })
    expect(res.status).toBe(201)
    expect(res.body.classRulesByRole).toEqual({})
    expect(res.body.dryRunRoles).toEqual([])
    expect(res.body.submissionClassesByRole).toEqual({})
  })
}

/**
 * The sandboxed run mode, END TO END through a real store on both runtimes.
 *
 * This is the assertion the feature shipped without, and the one that catches the whole class of
 * defect the unit tests structurally cannot. `mode` is settled at START, but the merge decision is
 * made on the DURABLE path, which rebuilds the run from its persisted row and nothing else. So
 * every hop between those two points has to carry it: the detail-JSON writer, the reader, and the
 * re-drive that mints a fresh run id over the same work. A `MergeResolver` unit test hands the
 * resolver an instance it built in memory and passes no matter which of those hops drops the
 * field — which is exactly what happened, on both runtimes, with the feature reporting success.
 *
 * These drive the run through the real HTTP start, the real engine and the real repository, so
 * they fail if `mode` fails to round-trip anywhere along that path.
 */
function registerDryRunTests(driveMergerRun: MergerRunDriver): void {
  /** A sandboxed run whose scores and preset would otherwise have merged it outright. */
  const driveSandboxed = () =>
    driveMergerRun({
      changedFiles: ['README.md'],
      assessment: { complexity: 0.1, risk: 0.1, impact: 0.1, rationale: 'trivial docs tweak' },
      preset: { classRules: { docs: 'always' } },
      mode: 'dry_run',
    })

  it('opens the PR but refuses to merge it, surviving the persistence round-trip', async () => {
    const run = await driveSandboxed()
    // The PR is deliberately still opened: what makes the mode a sandbox is that the change
    // cannot reach the default branch, not that the work stays invisible.
    expect(run.status).toBe('pr_ready')
    expect(run.decision.outcome).toBe('awaiting_review')
    // …and the reason names the sandbox rather than a ceiling nobody consulted. `docs: 'always'`
    // would have auto-merged this diff, so `class_auto_merge` here would mean the mode was lost
    // somewhere between the start request and the merge decision.
    expect(run.decision.reason).toBe('dry_run')
  })

  it('refuses the manual merge endpoint too, so the review card is not a way around it', async () => {
    // Without this the sandbox is decorative: declining to AUTO-merge only to leave a card whose
    // own button lands the change would let a run that was never authorised to merge do exactly
    // that, one tap later. The refusal reads the mode off the run the block points at, so it is
    // a second, independent proof that the mode persisted.
    const run = await driveSandboxed()
    const merged = await run.app.call('POST', `/workspaces/${run.wsId}/blocks/task_login/merge`, {})
    expect(merged.status).toBe(409)
    expect(
      (merged.body as { error?: { details?: { reason?: string } } }).error?.details?.reason,
    ).toBe('dry_run_not_mergeable')
  })

  it('leaves an ordinary live run merging exactly as before', async () => {
    // The identity that keeps this feature additive: the same run, same preset, same scores, with
    // no mode requested, must still auto-merge. A sandbox is never INFERRED.
    const run = await driveMergerRun({
      changedFiles: ['README.md'],
      assessment: { complexity: 0.1, risk: 0.1, impact: 0.1, rationale: 'trivial docs tweak' },
      preset: { classRules: { docs: 'always' } },
    })
    expect(run.status).toBe('done')
    expect(run.decision.outcome).toBe('auto_merged')
  })
}

/**
 * The per-role SUBMISSION ALLOWLIST, END TO END through a real store and a real signed session.
 *
 * What only this can prove: the policy is keyed on the role the run PINNED at admission, so the
 * chain under test starts at an authenticated HTTP start and runs through the persisted run row
 * to a merge decision made on the durable path, the same chain the sandboxed-run assertions
 * above exist for, and the one a `MergeResolver` unit test structurally cannot cover because it
 * hands the resolver an instance it built in memory.
 *
 * It also asserts BOTH exits, which is the whole difference between this setting and a `never`
 * class rule: refusing only the automatic one leaves a review card whose own button lands exactly
 * what the allowlist withholds.
 */
function registerSubmissionAllowlistTests(harness: ConformanceHarness): void {
  /** A workspace whose `task_login` runs are started by a real signed-in `member`. */
  async function memberWorkspace(app: ConformanceApp, tag: string) {
    const { accountId, ownerUserId: admin } = await app.onboarding().makeOrgOwner(`submit-${tag}`)
    const member = (
      await app.onboarding().users.findOrCreateByIdentity('github', `submit-member-${tag}`, {
        name: 'Member',
        email: `submit-member-${tag}@example.com`,
      })
    ).id
    await app.onboarding().addAccountMember(accountId, admin, member, ['developer'])
    const { workspace } = await app.createWorkspaceInAccount(accountId, admin, {
      name: `Submit ${tag}`,
      seed: true,
    })
    // The workspace role is written explicitly rather than inferred from the account membership:
    // what this suite is about is which TIER the run pins, so leaving that to a default would
    // make a change in account→workspace role mapping look like an allowlist regression.
    await app.workspaceMemberRepository().upsert({
      workspaceId: workspace.id,
      userId: member,
      role: 'member',
      createdAt: 1,
      addedByUserId: admin,
    })
    return {
      wsId: workspace.id,
      // Two sessions, because the split IS the scenario: authoring a merge preset is an
      // admin-tier write (`settings.manage`), and the whole point of the setting is that the
      // person it holds back is not the person who wrote it.
      memberAuth: { authorization: `Bearer ${await app.session({ id: member })}` },
      adminAuth: { authorization: `Bearer ${await app.session({ id: admin })}` },
    }
  }

  /** Run `coder` + `merger` on `task_login` as a member, under an allowlisted preset. */
  async function driveMemberRun(options: {
    tag: string
    changedFiles: string[]
    submissionClasses: string[]
  }) {
    const app = harness.makeApp(
      {
        confidence: 1,
        pullRequest: FAKE_PR,
        mergeAssessment: { complexity: 0.1, risk: 0.1, impact: 0.1, rationale: 'small change' },
      },
      {
        resolveRunRepoContext: async () => ({
          repo: repoWithChangedFiles(options.changedFiles),
          baseBranch: 'main',
          repoId: FAKE_REPO_ID,
          provider: 'github' as const,
        }),
      },
    )
    const { wsId, memberAuth, adminAuth } = await memberWorkspace(app, options.tag)
    const preset = await app.call<RiskPolicy>(
      'POST',
      `/workspaces/${wsId}/risk-policies`,
      {
        name: 'Scoped',
        maxComplexity: 0.5,
        maxRisk: 0.4,
        maxImpact: 0.5,
        ciMaxAttempts: 10,
        maxRequirementIterations: 6,
        maxRequirementConcernAllowed: 'none',
        // Widened to `always` on purpose: the allowlist has to beat the most permissive rule the
        // preset can carry, or it would only be a slower way of writing `never`.
        classRules: { docs: 'always', source: 'always' },
        submissionClassesByRole: { member: options.submissionClasses },
      },
      adminAuth,
    )
    expect(preset.status).toBe(201)
    await app.call(
      'PATCH',
      `/workspaces/${wsId}/blocks/task_login`,
      { riskPolicyId: preset.body.id },
      adminAuth,
    )
    const pipeline = await app.call<Pipeline>(
      'POST',
      `/workspaces/${wsId}/pipelines`,
      { name: 'Build + merger', purpose: 'build', agentKinds: ['coder', 'merger'] },
      adminAuth,
    )
    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
      memberAuth,
    )
    expect(start.status).toBe(201)
    const ticked = await app.drive(wsId)
    const exec = ticked.find((e) => e.blockId === 'task_login')!
    const snap = (
      await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`, undefined, adminAuth)
    ).body
    return {
      app,
      wsId,
      memberAuth,
      status: snap.blocks.find((b) => b.id === 'task_login')!.status,
      decision: exec.steps.find((s) => s.agentKind === 'merger')!.custom as {
        outcome?: string
        reason?: string
        thresholds?: { initiatorRole?: string; submissionClasses?: string[] }
      },
    }
  }

  it('lands a class the initiator’s role allowlists', async () => {
    const run = await driveMemberRun({
      tag: 'allowed',
      changedFiles: ['README.md'],
      submissionClasses: ['docs'],
    })
    expect(run.status).toBe('done')
    expect(run.decision.outcome).toBe('auto_merged')
    // The pinned role survived the persistence round-trip, which is what the policy keys on: had
    // it been dropped anywhere, the run would have landed as UNSCOPED and this suite would pass
    // for the wrong reason on the refusal case below.
    expect(run.decision.thresholds?.initiatorRole).toBe('member')
    expect(run.decision.thresholds?.submissionClasses).toEqual(['docs'])
  })

  it('refuses a class outside it at BOTH exits', async () => {
    const run = await driveMemberRun({
      tag: 'refused',
      changedFiles: ['src/login.ts'],
      submissionClasses: ['docs'],
    })
    // Exit one: the automatic merge. The PR is still opened, because the work is not the harm.
    expect(run.status).toBe('pr_ready')
    expect(run.decision).toMatchObject({
      outcome: 'awaiting_review',
      reason: 'submission_not_allowed',
    })

    // Exit two: the manual merge the review card offers. Without this the allowlist is decorative,
    // since the person who reads that card is routinely the person who started the run.
    const merged = await run.app.call(
      'POST',
      `/workspaces/${run.wsId}/blocks/task_login/merge`,
      {},
      run.memberAuth,
    )
    expect(merged.status).toBe(409)
    expect(
      (merged.body as { error?: { details?: { reason?: string } } }).error?.details?.reason,
    ).toBe('submission_not_allowed')
  })

  it('lands an unreadable diff whatever the allowlist says', async () => {
    // The inert reading of `unknown`, asserted through the real classification seam: a VCS that
    // cannot enumerate the changed files is an outage, and an outage may not change policy. That
    // is the opposite disposition from a class the allowlist simply omits.
    const run = await driveMemberRun({
      tag: 'unknown',
      changedFiles: [],
      submissionClasses: [],
    })
    expect(run.status).toBe('done')
    expect(run.decision.outcome).toBe('auto_merged')
  })
}

/**
 * The PUBLIC (`/api/v1`) half of the loop: reading a run's merge decision, reading the workspace's
 * per-class rollups, and TAGGING the reviewer effort with a key that cannot merge anything.
 *
 * What this proves that a unit test cannot is the wiring on BOTH facades: that each mounts the
 * merge-evidence controller, resolves the track-record module out of its own container, and reads
 * the same rows through its own SQL. A facade that shipped the controller and forgot the module
 * answers 503 here rather than shipping a surface a harness silently cannot use.
 *
 * The scope assertions are the point of the surface and not incidental: before this the only way
 * to record an effort tag over the API was the `admin`-scoped notification `act`, so an
 * integration whose whole job is collecting evidence had to hold a key that also merges pull
 * requests and deletes tasks.
 */
function registerPublicMergeEvidenceTests(driveMergerRun: MergerRunDriver): void {
  describe('public API: merge evidence', () => {
    /** Mint a public-API key at a chosen rung and return its bearer header. */
    async function mintKey(
      app: ConformanceApp,
      wsId: string,
      scope: 'read' | 'write' | 'admin',
    ): Promise<Record<string, string>> {
      const created = await app.call<{ secret: string }>(
        'POST',
        `/workspaces/${wsId}/public-api-keys`,
        { label: `conformance-merge-evidence-${scope}`, scope },
      )
      expect(created.status).toBe(201)
      return { authorization: `Bearer ${created.body.secret}` }
    }

    /**
     * Call a route expecting a REFUSAL, and surface its status beside the machine-readable
     * `details.reason` a caller actually branches on.
     *
     * Reading the reason through one helper is what keeps these cases honest: a status-only
     * assertion passes on a 404 whose `details` is absent entirely, which is exactly how the tag
     * route came to answer without the reason its siblings publish.
     */
    async function refusal(
      app: ConformanceApp,
      method: 'GET' | 'POST',
      path: string,
      auth: Record<string, string>,
      body?: unknown,
    ): Promise<{ status: number; reason?: string }> {
      const res = await app.call<{ error?: { details?: { reason?: string } } }>(
        method,
        path,
        body,
        auth,
      )
      return { status: res.status, reason: res.body?.error?.details?.reason }
    }

    /** A run parked on `merge_review`, in an ORG workspace so a key can be minted for it. */
    async function pendingRun() {
      const run = await driveMergerRun({
        org: true,
        changedFiles: ['src/login.ts'],
        assessment: { complexity: 0.9, risk: 0.9, impact: 0.9, rationale: 'Risky refactor.' },
      })
      expect(run.status).toBe('pr_ready')
      return run
    }

    it('serves a run’s merge decision to a read-scoped key', async () => {
      const run = await pendingRun()
      const auth = await mintKey(run.app, run.wsId, 'read')

      const read = await run.app.call<PublicMergeRecord>(
        'GET',
        `/api/v1/runs/${run.executionId}/merge-record`,
        undefined,
        auth,
      )
      expect(read.status).toBe(200)
      // The public id vocabulary, not the stored row's: a caller can address both of these.
      expect(read.body.runId).toBe(run.executionId)
      expect(read.body.taskId).toBe('task_login')
      expect(read.body.changeClass).toBe('source')
      expect(read.body.decision).toBe('pending_review')
      // Untagged reads as null, never as `none`: nobody has said this needed no review.
      expect(read.body.reviewEffort).toBeNull()
      expect(read.body.taggedAt).toBeNull()
      // The merger's scores travel with the decision, so a harness can see WHAT was judged rather
      // than only what was decided.
      expect(read.body.complexity).toBe(0.9)
      expect(read.body.prNumber).toBe(FAKE_PR.number)
      expect(read.body.repoId).toBe(FAKE_REPO_ID)

      // The same record addressed by its own id, which is what a `merge_tag_request` card hands out.
      const byId = await run.app.call<PublicMergeRecord>(
        'GET',
        `/api/v1/merge-records/${read.body.recordId}`,
        undefined,
        auth,
      )
      expect(byId.status).toBe(200)
      expect(byId.body).toEqual(read.body)
    })

    it('tags the reviewer effort with a WRITE key, which can merge nothing', async () => {
      const run = await pendingRun()
      const readAuth = await mintKey(run.app, run.wsId, 'read')
      const writeAuth = await mintKey(run.app, run.wsId, 'write')
      const record = await run.app.call<PublicMergeRecord>(
        'GET',
        `/api/v1/runs/${run.executionId}/merge-record`,
        undefined,
        readAuth,
      )
      const effortPath = `/api/v1/merge-records/${record.body.recordId}/effort`

      // A `read` key may look and not touch: the floor is enforced, not merely published.
      const refused = await run.app.call('POST', effortPath, { reviewEffort: 'minor' }, readAuth)
      expect(refused.status).toBe(403)

      const tagged = await run.app.call<PublicMergeRecord>(
        'POST',
        effortPath,
        { reviewEffort: 'major' },
        writeAuth,
      )
      expect(tagged.status).toBe(200)
      expect(tagged.body.reviewEffort).toBe('major')
      expect(tagged.body.taggedAt).toBeGreaterThan(0)
      // Tagging is orthogonal to the decision: the pull request is still awaiting its human.
      expect(tagged.body.decision).toBe('pending_review')

      // And it CLEARS with an explicit null, so a mistagged record is correctable by the same key
      // that tagged it rather than needing someone in the app.
      const cleared = await run.app.call<PublicMergeRecord>(
        'POST',
        effortPath,
        { reviewEffort: null },
        writeAuth,
      )
      expect(cleared.status).toBe(200)
      expect(cleared.body.reviewEffort).toBeNull()
      expect(cleared.body.taggedAt).toBeNull()
    })

    it('rolls every change class up in one request, including the ones with no records', async () => {
      const run = await pendingRun()
      const auth = await mintKey(run.app, run.wsId, 'read')

      const rolled = await run.app.call<{ rollups: MergeClassRollup[] }>(
        'GET',
        '/api/v1/merge-records/rollups',
        undefined,
        auth,
      )
      expect(rolled.status).toBe(200)
      // Derived from the same closed union the code reads rather than pinned to a count: adding a
      // class must not fail this, and omitting one must.
      expect(rolled.body.rollups.map((r) => r.changeClass).sort()).toEqual(
        [...CHANGE_CLASSES].sort(),
      )
      const source = rolled.body.rollups.find((r) => r.changeClass === 'source')!
      expect(source.pendingReview).toBe(1)
      expect(source.merged).toBe(0)
      // A class nobody has landed anything in is present as ZEROS: "nothing yet" and "left out of
      // the response" are different facts, and only one of them is about the workspace.
      expect(rolled.body.rollups.find((r) => r.changeClass === 'schema')!.total).toBe(0)
    })

    it('tells apart an unreadable run, a run that decided nothing, and an unknown record', async () => {
      const run = await pendingRun()
      const auth = await mintKey(run.app, run.wsId, 'read')

      // An id naming no run this key may read. Its own reason, because the fix differs: stop
      // asking, where `no_merge_record` below means keep watching a run that is genuinely there.
      const noRun = await refusal(run.app, 'GET', '/api/v1/runs/exec_nope/merge-record', auth)
      expect(noRun.status).toBe(404)
      expect(noRun.reason).toBe('run_not_found')

      // A run with no `merger` step reaches no merge decision. That is a fact about the run, so it
      // gets its own reason: a caller must be able to tell it from an id it simply cannot see.
      //
      // On a FRESH task under the same service rather than a seeded sibling: `task_refresh`
      // declares a dependency on `task_login`, which the parked run above left at `pr_ready`
      // rather than `done`, so starting it is a 409 about ordering and not about this assertion.
      const coderOnly = await run.app.call<Pipeline>('POST', `/workspaces/${run.wsId}/pipelines`, {
        name: 'Coder only',
        purpose: 'build',
        agentKinds: ['coder'],
      })
      const task = await run.app.call<{ id: string }>(
        'POST',
        `/workspaces/${run.wsId}/blocks/blk_auth/tasks`,
        { title: 'No merger here' },
      )
      expect(task.status).toBe(201)
      const started = await run.app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${run.wsId}/blocks/${task.body.id}/executions`,
        { pipelineId: coderOnly.body.id },
      )
      expect(started.status).toBe(201)
      const noRecord = await refusal(
        run.app,
        'GET',
        `/api/v1/runs/${started.body.id}/merge-record`,
        auth,
      )
      expect(noRecord.status).toBe(404)
      expect(noRecord.reason).toBe('no_merge_record')

      // An unknown record id is a 404 rather than a 200 with a nulled-out body, and the READ and
      // the TAG answer it with the SAME reason, because from a caller's side they are one fact
      // about one id. Driving both is what keeps them that way: the tag's 404 is raised deep in
      // `MergeTrackRecordService`, so it is the one that silently loses its reason when the two
      // are spelled independently.
      const unknownRead = await refusal(run.app, 'GET', '/api/v1/merge-records/mtr_nope', auth)
      expect(unknownRead.status).toBe(404)
      expect(unknownRead.reason).toBe('merge_record_not_found')

      const writeAuth = await mintKey(run.app, run.wsId, 'write')
      const unknownTag = await refusal(
        run.app,
        'POST',
        '/api/v1/merge-records/mtr_nope/effort',
        writeAuth,
        { reviewEffort: 'minor' },
      )
      expect(unknownTag.status).toBe(404)
      expect(unknownTag.reason).toBe('merge_record_not_found')
    })

    it('confirms the merge and records the effort in ONE headless request', async () => {
      // The whole point of giving `act` a body. Before it, a harness that merged through the API
      // had to follow up with a second call to say what reviewing it cost, and the two could
      // interleave with anything; now the tag lands in the same request that merges, which is
      // what the app's one-tap confirm-and-tag has always done.
      const run = await pendingRun()
      const adminAuth = await mintKey(run.app, run.wsId, 'admin')
      const readAuth = await mintKey(run.app, run.wsId, 'read')

      const inbox = await run.app.call<{ notifications: PublicNotificationCard[] }>(
        'GET',
        '/api/v1/notifications',
        undefined,
        readAuth,
      )
      const card = inbox.body.notifications.find((n) => n.type === 'merge_review')
      expect(card, 'merge_review card on the public inbox').toBeDefined()

      const acted = await run.app.call<{ status: string }>(
        'POST',
        `/api/v1/notifications/${card!.id}/act`,
        { reviewEffort: 'none' },
        adminAuth,
      )
      expect(acted.status).toBe(200)
      expect(acted.body.status).toBe('acted')

      // BOTH halves landed off the one call: the pull request merged (the record settled as
      // `human_merged`) and the effort is on the record rather than still null.
      const record = await run.app.call<PublicMergeRecord>(
        'GET',
        `/api/v1/runs/${run.executionId}/merge-record`,
        undefined,
        readAuth,
      )
      expect(record.status).toBe(200)
      expect(record.body.decision).toBe('human_merged')
      expect(record.body.reviewEffort).toBe('none')
      expect(record.body.taggedAt).toBeGreaterThan(0)
    })

    it('still acts on a request that sends NO body at all', async () => {
      // The compatibility guarantee behind the body being additive. An integration that has
      // called this route since 1.0 sends no body, and the contract validator reads
      // `c.req.json()` before the schema, so without `optionalJsonBody` on the route the tag
      // field would have turned every one of those callers into a 400 on upgrade.
      const run = await pendingRun()
      const adminAuth = await mintKey(run.app, run.wsId, 'admin')
      const readAuth = await mintKey(run.app, run.wsId, 'read')
      const inbox = await run.app.call<{ notifications: PublicNotificationCard[] }>(
        'GET',
        '/api/v1/notifications',
        undefined,
        readAuth,
      )
      const card = inbox.body.notifications.find((n) => n.type === 'merge_review')!

      // `undefined` here is no body on the wire, not an empty one.
      const acted = await run.app.call<{ status: string }>(
        'POST',
        `/api/v1/notifications/${card.id}/act`,
        undefined,
        adminAuth,
      )
      expect(acted.status).toBe(200)
      expect(acted.body.status).toBe('acted')

      // It merged, and left the tag unsaid rather than guessing at `none`.
      const record = await run.app.call<PublicMergeRecord>(
        'GET',
        `/api/v1/runs/${run.executionId}/merge-record`,
        undefined,
        readAuth,
      )
      expect(record.body.decision).toBe('human_merged')
      expect(record.body.reviewEffort).toBeNull()
      expect(record.body.taggedAt).toBeNull()
    })

    it('refuses a REAL record to a key from another workspace, by run and by record id', async () => {
      // The workspace predicate, driven against a record that genuinely EXISTS. An assertion that
      // only ever asks for `mtr_nope` passes on a repository that dropped its workspace predicate
      // entirely, which is the one bug this case is here to catch: the id is unknown everywhere,
      // so the refusal proves nothing about scoping.
      const run = await pendingRun()
      const record = await run.app.call<PublicMergeRecord>(
        'GET',
        `/api/v1/runs/${run.executionId}/merge-record`,
        undefined,
        await mintKey(run.app, run.wsId, 'read'),
      )
      expect(record.status).toBe(200)

      // A second org board on the SAME deployment, so both rows live in one store and only the
      // workspace predicate stands between them.
      const { workspace: other } = await run.app.createOrgWorkspace({ seed: true })
      const foreignRead = await mintKey(run.app, other.id, 'read')
      const foreignWrite = await mintKey(run.app, other.id, 'write')

      // Every door onto the record, each refusing with the reason its own address implies: the
      // run-scoped read never confirms the run exists, and the two record-addressed routes never
      // confirm the record does.
      const byRun = await refusal(
        run.app,
        'GET',
        `/api/v1/runs/${run.executionId}/merge-record`,
        foreignRead,
      )
      expect(byRun.status).toBe(404)
      expect(byRun.reason).toBe('run_not_found')

      const byId = await refusal(
        run.app,
        'GET',
        `/api/v1/merge-records/${record.body.recordId}`,
        foreignRead,
      )
      expect(byId.status).toBe(404)
      expect(byId.reason).toBe('merge_record_not_found')

      // And the WRITE cannot reach across either. A foreign key with the right rung is still the
      // wrong workspace, and a tag that landed here would corrupt another board's rollups.
      const tagged = await refusal(
        run.app,
        'POST',
        `/api/v1/merge-records/${record.body.recordId}/effort`,
        foreignWrite,
        { reviewEffort: 'major' },
      )
      expect(tagged.status).toBe(404)
      expect(tagged.reason).toBe('merge_record_not_found')

      // The record itself is untouched: the refusals above refused, they did not half-apply.
      const stillOwned = await run.app.call<PublicMergeRecord>(
        'GET',
        `/api/v1/merge-records/${record.body.recordId}`,
        undefined,
        await mintKey(run.app, run.wsId, 'read'),
      )
      expect(stillOwned.status).toBe(200)
      expect(stillOwned.body.reviewEffort).toBeNull()
    })
  })
}
