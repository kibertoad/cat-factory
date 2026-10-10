// A per-RUN control seam for the deterministic fakes. The e2e backend boots ONCE and
// serves EVERY spec (single shared Node process + a single production frontend build),
// so the fake-agent knobs that used to be GLOBAL env vars (`E2E_CONFIDENCE`,
// `E2E_ASYNC_KINDS`, `E2E_DISPATCH_THROW_KINDS`) can't vary per spec: flipping one
// globally would change behaviour for every other spec sharing the process.
//
// Instead a spec sets a `FakeProfile` for ITS OWN freshly-seeded workspace over a
// test-only control channel (see `testServer.ts`), exactly the way existing specs vary
// behaviour by choosing a pipeline SHAPE over REST. The profile is keyed by workspace id;
// the two wrappers below resolve the right per-workspace behaviour on each call (both the
// agent-run context and the job handle carry `workspaceId`). A workspace with NO profile
// falls back to the base options, so the 8 pre-existing specs are byte-identical.

import {
  AsyncFakeAgentExecutor,
  FakeRepoBootstrapper,
  makeFakeCi,
  makeFakeMergeability,
  makeFakeReleaseHealth,
} from '@cat-factory/conformance'

/** The per-workspace fake behaviour a spec can request. All fields optional; absent ⇒ base. */
export interface FakeProfile {
  /** Confidence the fake reports on the final step (drives auto-merge vs merge-review). */
  confidence?: number
  /** Step indices that raise a one-shot human decision. Pass `[]` to disable the default gate. */
  decisionOnSteps?: number[]
  /** Agent kinds driven as a POLLED async job (surfacing subtask bars) instead of inline. */
  asyncKinds?: string[]
  /** Agent kinds whose container dispatch THROWS (the run faults with `failureKind: 'dispatch'`). */
  dispatchThrowKinds?: string[]
  /** Number of `running` polls an async job reports before `done` (default 2). */
  asyncPolls?: number
  /** Subtask snapshots the bootstrap run emits (one per running poll) before it finishes. */
  bootstrapProgress?: { completed: number; inProgress: number; total: number }[]
  /** When set, the bootstrap run reports FAILED on poll (the failure-banner + retry path). */
  bootstrapFailWith?: string
  /**
   * The `result.custom` a STRUCTURED agent kind returns (e.g. the `environment-analyst` draft the
   * setup wizard reads back off the step). Absent ⇒ the fake's default `{ ok: true }`.
   */
  customResult?: unknown
  /**
   * The plan draft the `initiative-planner` step returns as `result.initiativePlan` (an
   * `InitiativePlanDraft`), so a spec can drive an initiative PLANNING run to completion —
   * create-with-preset → auto-plan → the loop spawning the decorated tasks. Absent ⇒ the planner
   * emits no plan and the run faults (the planner requires one), so any initiative-planning spec
   * must set it.
   */
  initiativePlan?: unknown

  // ---- Inline-LLM scripts (consumed by `E2eInlineModels`, NOT the agent executor: the
  // requirements-review loop's calls run inline through the `ModelProvider` port). ----
  /**
   * The findings the requirements REVIEWER raises on its first pass, in the wire shape
   * `coerceReviewItems` reads. Absent / empty ⇒ the reviewer finds nothing and the gate
   * auto-passes, which is the base behaviour every other spec relies on. The re-review always
   * converges, so a scripted set drives exactly one park → answer → incorporate → settle loop.
   *
   * Leave `autoAnswerable` false (the default). A `true` finding makes the engine fire the
   * Requirement Writer over it, which is a second inline call and a second thing for the spec to
   * wait on, and the fake RECOMMENDS NOTHING (`inlineReplyFor` answers that call with an empty
   * recommendation set, because a synthesized product recommendation would be indistinguishable
   * from a real one in the window). So the finding comes back still `open`, which is a real product
   * state but not the automation. A spec about the auto-recommendation needs a script field here
   * first; the call itself is already classified, so it reads as the recommendation it is rather
   * than as an interview.
   */
  reviewFindings?: {
    title: string
    detail: string
    category?: 'gap' | 'clarification' | 'assumption' | 'risk' | 'question'
    severity?: 'low' | 'medium' | 'high'
    autoAnswerable?: boolean
  }[]
  /** The document the incorporation companion returns when folding the answers in. */
  incorporatedRequirements?: string

  // ---- Judge verdicts (consumed by `E2eJudgeAssessor`) — a queue whose last entry repeats. ----
  /**
   * The score the registered JUDGE returns per assessment: `[0.4, 0.9]` fails the default
   * threshold once (bouncing the producer) then passes, `[0.4, 0.4]` spends the bounce budget
   * and parks for a human. Absent ⇒ a passing `1`, so a workspace that never places a judge step
   * is unaffected.
   */
  judgeScores?: number[]

  // ---- Operational-gate verdict scripts (consumed by the E2eGateProviders wrapper, NOT the
  // agent executor) — each is a per-probe queue whose last entry repeats. ----
  /** CI check verdict per gate probe: `[false, true]` = red then green after the ci-fixer round. */
  ciStatus?: boolean[]
  /** PR mergeability per probe: `['conflicted','mergeable']` drives the conflict-resolver round. */
  mergeability?: ('mergeable' | 'conflicted' | 'unknown')[]
  /** Release-health verdict per probe: `['regressed']` escalates the on-call agent. */
  releaseHealth?: ('healthy' | 'pending' | 'regressed')[]

  // ---- Agent-loop knobs (forwarded straight into FakeAgentOptions by profileToOptions) ----
  /** Test reports, one per Tester call (last repeats): `[notGreen, green]` drives Tester→Fixer. */
  testReports?: unknown[]
  /** Companion ratings, one per grade (last repeats): drives + recovers the rework loop. */
  companionRatings?: number[]
  /** A single companion rating (default 1). `0.4` loops the producer to its rework cap. */
  companionRating?: number
  /** Force every companion reply unparseable (the verdict-parse guard). */
  companionMalformed?: boolean
  /** Follow-up items the async coder streams on its first poll (the Follow-up companion gate). */
  followUps?: { kind: 'follow_up' | 'question'; title: string; detail?: string }[]
  /** Agent kinds whose async poll reports a structured failure (implicitly async). */
  pollFailKinds?: string[]
  /** The structured `failureCause` a {@link pollFailKinds} poll reports. */
  pollFailCause?: string
  /** The merger's assessment (overrides the confidence-derived default). */
  mergeAssessment?: { complexity: number; risk: number; impact: number; rationale: string }
  /** The on-call agent's assessment (post-release-health escalation). */
  onCallAssessment?: {
    culpritConfidence: number
    recommendation: 'revert' | 'hold' | 'monitor'
    rationale: string
    evidence?: string[]
  }
  /** A PR the container-flavoured agent reports opening (a fixer needs a branch to fix). */
  pullRequest?: { url: string; number: number; branch: string }
  /** Model a container-reusing runner (the stale-replay bug shape); default per-run container. */
  pooledContainer?: boolean
}

// Structural types derived from the conformance fakes, so this test-only package needs no
// direct `@cat-factory/kernel` dependency (it isn't one) — mirrors `testServer.ts`.
type AgentCtx = Parameters<AsyncFakeAgentExecutor['run']>[0]
type JobHandle = Awaited<ReturnType<AsyncFakeAgentExecutor['startJob']>>
type ReclaimTarget = Parameters<AsyncFakeAgentExecutor['reclaimRun']>[0]
type FakeOptions = ConstructorParameters<typeof AsyncFakeAgentExecutor>[0] & {}
type BootstrapRequest = Parameters<FakeRepoBootstrapper['startBootstrap']>[0]
type BootstrapHandle = Parameters<FakeRepoBootstrapper['pollBootstrap']>[0]

const DEFAULT_KEY = '__default__'

/**
 * A cache of per-workspace fakes derived from {@link FakeProfile}s, re-armable per workspace.
 * Exported because two of those caches live in sibling modules (`fakeInlineModel.ts`,
 * `fakeJudge.ts`) — a fake that registers itself is how a profile write reaches it.
 */
export interface WorkspaceScopedFakes {
  /** Drop the cached fake(s) for `workspaceId` so the next call rebuilds from the live profile. */
  resetWorkspace(workspaceId: string): void
}

/**
 * The per-workspace fake-behaviour store, plus every cache derived from it.
 *
 * Each wrapper below caches one fake per workspace — they own per-workspace state (job maps,
 * companion/tester counters, gate probe sequences) that has to survive across the many calls of
 * a single run — and each reads the profile exactly ONCE, when it builds that fake. So a spec
 * normally sets its profile BEFORE starting the run it wants to shape.
 *
 * A spec that legitimately needs to change behaviour PART-WAY through a workspace's life (the
 * checkpoint spec re-arms the human decision gate so the NEXT phase's run parks rather than
 * settling straight to `done`) would otherwise be writing into a map nobody reads again. That
 * no-op is silent, and it surfaces only as a load-dependent e2e flake: the run the spec meant to
 * park races to completion instead, and whatever the spec was watching for is gone before the
 * browser can paint it. So a write RE-ARMS that workspace: the cached fakes are dropped and the
 * next call rebuilds them from the profile just written.
 *
 * Re-arming resets that workspace's counters and in-memory job map along with its options, so a
 * write landing while one of ITS OWN async jobs is mid-poll would strand that job. Every caller
 * today writes either before the run or while the workspace is quiescent.
 */
export class FakeProfileRegistry {
  private readonly profiles = new Map<string, FakeProfile>()
  private readonly caches = new Set<WorkspaceScopedFakes>()

  /** Register a profile-derived cache so {@link set} re-arms it. Each wrapper registers itself. */
  register(cache: WorkspaceScopedFakes): void {
    this.caches.add(cache)
  }

  /** A workspace's profile; absent ⇒ base behaviour. */
  get(workspaceId: string): FakeProfile | undefined {
    return this.profiles.get(workspaceId)
  }

  /** Install a workspace's profile and re-arm every fake derived from it. */
  set(workspaceId: string, profile: FakeProfile): void {
    this.profiles.set(workspaceId, profile)
    for (const cache of this.caches) cache.resetWorkspace(workspaceId)
  }
}

/** Fold a resolved profile into the fake-agent constructor options (base ⊕ profile). */
function profileToOptions(profile: FakeProfile | undefined): FakeOptions {
  if (!profile) return {}
  // A thrown dispatch or a structured poll-failure is only meaningful for an async (polled)
  // kind, so any dispatch-throw / poll-fail kind is implicitly async too — mirrors the original
  // `testServer.ts` env wiring.
  const asyncKinds = [
    ...new Set([
      ...(profile.asyncKinds ?? []),
      ...(profile.dispatchThrowKinds ?? []),
      ...(profile.pollFailKinds ?? []),
    ]),
  ]
  return {
    ...(profile.confidence !== undefined ? { confidence: profile.confidence } : {}),
    ...(profile.decisionOnSteps !== undefined ? { decisionOnSteps: profile.decisionOnSteps } : {}),
    ...(asyncKinds.length ? { asyncKinds: asyncKinds as FakeOptions['asyncKinds'] } : {}),
    ...(profile.dispatchThrowKinds?.length
      ? { dispatchThrowKinds: profile.dispatchThrowKinds as FakeOptions['dispatchThrowKinds'] }
      : {}),
    ...(profile.pollFailKinds?.length
      ? { pollFailKinds: profile.pollFailKinds as FakeOptions['pollFailKinds'] }
      : {}),
    ...(profile.pollFailCause !== undefined
      ? { pollFailCause: profile.pollFailCause as FakeOptions['pollFailCause'] }
      : {}),
    ...(profile.asyncPolls !== undefined ? { asyncPolls: profile.asyncPolls } : {}),
    ...(profile.customResult !== undefined
      ? { customResult: profile.customResult as FakeOptions['customResult'] }
      : {}),
    ...(profile.initiativePlan !== undefined
      ? { initiativePlan: profile.initiativePlan as FakeOptions['initiativePlan'] }
      : {}),
    // Agent retry-loop knobs (already present on FakeAgentOptions — just surfaced per-workspace).
    ...(profile.testReports !== undefined
      ? { testReports: profile.testReports as FakeOptions['testReports'] }
      : {}),
    ...(profile.companionRatings !== undefined
      ? { companionRatings: profile.companionRatings }
      : {}),
    ...(profile.companionRating !== undefined ? { companionRating: profile.companionRating } : {}),
    ...(profile.companionMalformed !== undefined
      ? { companionMalformed: profile.companionMalformed }
      : {}),
    ...(profile.followUps !== undefined ? { followUps: profile.followUps } : {}),
    ...(profile.mergeAssessment !== undefined ? { mergeAssessment: profile.mergeAssessment } : {}),
    ...(profile.onCallAssessment !== undefined
      ? { onCallAssessment: profile.onCallAssessment }
      : {}),
    ...(profile.pullRequest !== undefined
      ? { pullRequest: profile.pullRequest as FakeOptions['pullRequest'] }
      : {}),
    ...(profile.pooledContainer !== undefined ? { pooledContainer: profile.pooledContainer } : {}),
  }
}

/**
 * Agent executor that resolves its behaviour PER WORKSPACE from a shared, mutable profile
 * map. It delegates every call to a per-workspace {@link AsyncFakeAgentExecutor} built from
 * the base options merged with that workspace's profile — so per-workspace state (job maps,
 * companion/tester counters) stays isolated, which is exactly what the serial suite wants.
 * Always async-capable (implements the async methods); a workspace with no async kinds simply
 * reports `runsAsync === false` and runs inline, identical to the plain fake.
 *
 * NOTE: a workspace's instance is built lazily on its FIRST agent call and its profile is read
 * then, so a spec normally `setFakeProfile`s BEFORE it starts the run (most do: seed → set →
 * start). A profile written LATER still takes effect — {@link FakeProfileRegistry.set} re-arms
 * this cache — at the cost of resetting that workspace's job map and counters.
 */
export class E2eFakeAgentExecutor implements WorkspaceScopedFakes {
  private readonly instances = new Map<string, AsyncFakeAgentExecutor>()
  private readonly base: FakeOptions
  private readonly registry: FakeProfileRegistry

  constructor(base: FakeOptions, registry: FakeProfileRegistry) {
    this.base = base
    this.registry = registry
    registry.register(this)
  }

  resetWorkspace(workspaceId: string): void {
    this.instances.delete(workspaceId)
  }

  private forWorkspace(workspaceId: string | undefined): AsyncFakeAgentExecutor {
    const key = workspaceId ?? DEFAULT_KEY
    let inst = this.instances.get(key)
    if (!inst) {
      const profile = workspaceId ? this.registry.get(workspaceId) : undefined
      inst = new AsyncFakeAgentExecutor({ ...this.base, ...profileToOptions(profile) })
      this.instances.set(key, inst)
    }
    return inst
  }

  async resolveModel(): Promise<string> {
    return 'fake'
  }

  run(context: AgentCtx) {
    return this.forWorkspace(context.workspaceId).run(context)
  }

  runsAsync(context: AgentCtx): boolean {
    return this.forWorkspace(context.workspaceId).runsAsync(context)
  }

  startJob(context: AgentCtx) {
    return this.forWorkspace(context.workspaceId).startJob(context)
  }

  pollJob(handle: JobHandle) {
    return this.forWorkspace(handle.workspaceId).pollJob(handle)
  }

  reclaimRun(target: ReclaimTarget) {
    return this.forWorkspace(target.workspaceId).reclaimRun(target)
  }
}

/**
 * Repo bootstrapper that resolves its scripted lifecycle PER WORKSPACE from the same profile
 * map — so a bootstrap spec can request a progress script (happy path) or a poll-time failure
 * (the failure-banner + retry path) for its own workspace without touching any other spec.
 */
export class E2eRepoBootstrapper implements WorkspaceScopedFakes {
  private readonly instances = new Map<string, FakeRepoBootstrapper>()
  private readonly registry: FakeProfileRegistry

  constructor(registry: FakeProfileRegistry) {
    this.registry = registry
    registry.register(this)
  }

  resetWorkspace(workspaceId: string): void {
    this.instances.delete(workspaceId)
  }

  private forWorkspace(workspaceId: string): FakeRepoBootstrapper {
    let inst = this.instances.get(workspaceId)
    if (!inst) {
      inst = new FakeRepoBootstrapper()
      const profile = this.registry.get(workspaceId)
      if (profile?.bootstrapProgress) {
        inst.progressScript = profile.bootstrapProgress as typeof inst.progressScript
      }
      if (profile?.bootstrapFailWith) inst.failPollWith = profile.bootstrapFailWith
      this.instances.set(workspaceId, inst)
    }
    return inst
  }

  isWorkspaceConnected(workspaceId: string) {
    return this.forWorkspace(workspaceId).isWorkspaceConnected()
  }

  resolveMonorepoTarget(workspaceId: string, repoGithubId: number) {
    return this.forWorkspace(workspaceId).resolveMonorepoTarget(workspaceId, repoGithubId)
  }

  resolveReferenceRepo(
    workspaceId: string,
    ref: Parameters<FakeRepoBootstrapper['resolveReferenceRepo']>[1],
  ) {
    return this.forWorkspace(workspaceId).resolveReferenceRepo(workspaceId, ref)
  }

  markRepoAsMonorepo(workspaceId: string, repoGithubId: number) {
    return this.forWorkspace(workspaceId).markRepoAsMonorepo(workspaceId, repoGithubId)
  }

  startBootstrap(request: BootstrapRequest) {
    return this.forWorkspace(request.workspaceId).startBootstrap(request)
  }

  pollBootstrap(handle: BootstrapHandle) {
    return this.forWorkspace(handle.workspaceId).pollBootstrap(handle)
  }

  stopBootstrap(handle: BootstrapHandle) {
    return this.forWorkspace(handle.workspaceId).stopBootstrap(handle)
  }

  projectBootstrappedRepo(
    workspaceId: string,
    outcome: Parameters<FakeRepoBootstrapper['projectBootstrappedRepo']>[1],
  ) {
    return this.forWorkspace(workspaceId).projectBootstrappedRepo(workspaceId, outcome)
  }
}

// The gate-provider port shapes, derived from the shared conformance factories so this
// test-only package needs no direct `@cat-factory/kernel` dependency (mirrors how `AgentCtx`
// / `JobHandle` are derived above).
type FakeCiProvider = ReturnType<typeof makeFakeCi>
type FakeMergeabilityProvider = ReturnType<typeof makeFakeMergeability>
type FakeReleaseHealthProvider = ReturnType<typeof makeFakeReleaseHealth>

/**
 * The built-in gates' data-source providers, resolved PER WORKSPACE from the shared profile
 * map — the gate analogue of {@link E2eFakeAgentExecutor}. The e2e backend boots once, so a
 * single provider object is wired into `buildNodeContainer`'s `gateProviders` seam, but each
 * `getStatus`/`getMergeability`/`probe` call carries `workspaceId`, so it dispatches to a
 * per-workspace fake built lazily on first probe from that workspace's `ciStatus` /
 * `mergeability` / `releaseHealth` script (each factory closes over its own sequence counter,
 * giving per-workspace isolation for free). Defaults (green / mergeable / healthy) make the
 * providers inert for any workspace that doesn't script a gate — and for the pre-existing
 * specs, whose pipelines contain no gate steps, they are never probed at all.
 *
 * NOTE: like {@link E2eFakeAgentExecutor}, a workspace's fake is built on its FIRST probe and
 * reads the profile then, so a spec normally `setFakeProfile`s BEFORE starting the run. A later
 * write still takes effect — {@link FakeProfileRegistry.set} re-arms this cache — at the cost of
 * restarting that workspace's verdict sequences from the top.
 */
export class E2eGateProviders implements WorkspaceScopedFakes {
  private readonly ciByWs = new Map<string, FakeCiProvider>()
  private readonly mrgByWs = new Map<string, FakeMergeabilityProvider>()
  private readonly relByWs = new Map<string, FakeReleaseHealthProvider>()
  private readonly registry: FakeProfileRegistry

  // A plain field + body assignment, NOT a `private readonly` parameter property: the e2e
  // backend runs under Node type-stripping, whose strip-only mode rejects parameter properties
  // (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Mirrors E2eRepoBootstrapper / E2eFakeAgentExecutor.
  constructor(registry: FakeProfileRegistry) {
    this.registry = registry
    registry.register(this)
  }

  resetWorkspace(workspaceId: string): void {
    this.ciByWs.delete(workspaceId)
    this.mrgByWs.delete(workspaceId)
    this.relByWs.delete(workspaceId)
  }

  private forCi(workspaceId: string): FakeCiProvider {
    let inst = this.ciByWs.get(workspaceId)
    if (!inst) {
      inst = makeFakeCi(this.registry.get(workspaceId)?.ciStatus ?? [true])
      this.ciByWs.set(workspaceId, inst)
    }
    return inst
  }

  private forMergeability(workspaceId: string): FakeMergeabilityProvider {
    let inst = this.mrgByWs.get(workspaceId)
    if (!inst) {
      inst = makeFakeMergeability(this.registry.get(workspaceId)?.mergeability ?? ['mergeable'])
      this.mrgByWs.set(workspaceId, inst)
    }
    return inst
  }

  private forReleaseHealth(workspaceId: string): FakeReleaseHealthProvider {
    let inst = this.relByWs.get(workspaceId)
    if (!inst) {
      inst = makeFakeReleaseHealth(this.registry.get(workspaceId)?.releaseHealth ?? ['healthy'])
      this.relByWs.set(workspaceId, inst)
    }
    return inst
  }

  /** The `ci` gate's check-runs source (per-workspace `ciStatus` script). */
  readonly ciStatus: FakeCiProvider = {
    getStatus: (workspaceId, blockId) => this.forCi(workspaceId).getStatus(workspaceId, blockId),
  }

  /** The `conflicts` gate's mergeability source (per-workspace `mergeability` script). */
  readonly mergeability: FakeMergeabilityProvider = {
    getMergeability: (workspaceId, blockId) =>
      this.forMergeability(workspaceId).getMergeability(workspaceId, blockId),
  }

  /** The `post-release-health` gate's release-health source (per-workspace `releaseHealth` script). */
  readonly releaseHealth: FakeReleaseHealthProvider = {
    probe: (workspaceId, blockId, since) =>
      this.forReleaseHealth(workspaceId).probe(workspaceId, blockId, since),
    gatherEvidence: (workspaceId, blockId, since) =>
      this.forReleaseHealth(workspaceId).gatherEvidence(workspaceId, blockId, since),
  }
}
