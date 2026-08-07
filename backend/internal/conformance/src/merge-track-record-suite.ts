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
}) => Promise<{
  app: ConformanceApp
  wsId: string
  executionId: string
  status: string
  decision: { outcome?: string; reason?: string; changeClass?: string }
}>

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
      const { workspace } = await app.createWorkspace()
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
      { name: 'Build + merger', agentKinds: ['coder', 'merger'] },
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
