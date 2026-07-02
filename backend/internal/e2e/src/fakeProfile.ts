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

import { AsyncFakeAgentExecutor, FakeRepoBootstrapper } from '@cat-factory/conformance'

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
}

// Structural types derived from the conformance fakes, so this test-only package needs no
// direct `@cat-factory/kernel` dependency (it isn't one) — mirrors `testServer.ts`.
type AgentCtx = Parameters<AsyncFakeAgentExecutor['run']>[0]
type JobHandle = Awaited<ReturnType<AsyncFakeAgentExecutor['startJob']>>
type FakeOptions = ConstructorParameters<typeof AsyncFakeAgentExecutor>[0] & {}
type BootstrapRequest = Parameters<FakeRepoBootstrapper['startBootstrap']>[0]
type BootstrapHandle = Parameters<FakeRepoBootstrapper['pollBootstrap']>[0]

const DEFAULT_KEY = '__default__'

/** Fold a resolved profile into the fake-agent constructor options (base ⊕ profile). */
function profileToOptions(profile: FakeProfile | undefined): FakeOptions {
  if (!profile) return {}
  // A thrown dispatch is only meaningful for an async (polled) kind, so any dispatch-throw
  // kind is implicitly async too — mirrors the original `testServer.ts` env wiring.
  const asyncKinds = [
    ...new Set([...(profile.asyncKinds ?? []), ...(profile.dispatchThrowKinds ?? [])]),
  ]
  return {
    ...(profile.confidence !== undefined ? { confidence: profile.confidence } : {}),
    ...(profile.decisionOnSteps !== undefined ? { decisionOnSteps: profile.decisionOnSteps } : {}),
    ...(asyncKinds.length ? { asyncKinds: asyncKinds as FakeOptions['asyncKinds'] } : {}),
    ...(profile.dispatchThrowKinds?.length
      ? { dispatchThrowKinds: profile.dispatchThrowKinds as FakeOptions['dispatchThrowKinds'] }
      : {}),
    ...(profile.asyncPolls !== undefined ? { asyncPolls: profile.asyncPolls } : {}),
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
 * then, so a spec must `setFakeProfile` BEFORE it starts the run (every spec does: seed → set →
 * start).
 */
export class E2eFakeAgentExecutor {
  private readonly instances = new Map<string, AsyncFakeAgentExecutor>()
  private readonly base: FakeOptions
  private readonly profiles: ReadonlyMap<string, FakeProfile>

  constructor(base: FakeOptions, profiles: ReadonlyMap<string, FakeProfile>) {
    this.base = base
    this.profiles = profiles
  }

  private forWorkspace(workspaceId: string | undefined): AsyncFakeAgentExecutor {
    const key = workspaceId ?? DEFAULT_KEY
    let inst = this.instances.get(key)
    if (!inst) {
      const profile = workspaceId ? this.profiles.get(workspaceId) : undefined
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

  stopJob(handle: JobHandle) {
    return this.forWorkspace(handle.workspaceId).stopJob(handle)
  }
}

/**
 * Repo bootstrapper that resolves its scripted lifecycle PER WORKSPACE from the same profile
 * map — so a bootstrap spec can request a progress script (happy path) or a poll-time failure
 * (the failure-banner + retry path) for its own workspace without touching any other spec.
 */
export class E2eRepoBootstrapper {
  private readonly instances = new Map<string, FakeRepoBootstrapper>()
  private readonly profiles: ReadonlyMap<string, FakeProfile>

  constructor(profiles: ReadonlyMap<string, FakeProfile>) {
    this.profiles = profiles
  }

  private forWorkspace(workspaceId: string): FakeRepoBootstrapper {
    let inst = this.instances.get(workspaceId)
    if (!inst) {
      inst = new FakeRepoBootstrapper()
      const profile = this.profiles.get(workspaceId)
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

  startBootstrap(request: BootstrapRequest) {
    return this.forWorkspace(request.workspaceId).startBootstrap(request)
  }

  pollBootstrap(handle: BootstrapHandle) {
    return this.forWorkspace(handle.workspaceId).pollBootstrap(handle)
  }

  stopBootstrap(handle: BootstrapHandle) {
    return this.forWorkspace(handle.workspaceId).stopBootstrap(handle)
  }

  linkRepoToBlock(
    workspaceId: string,
    outcome: Parameters<FakeRepoBootstrapper['linkRepoToBlock']>[1],
    blockId: string,
  ) {
    return this.forWorkspace(workspaceId).linkRepoToBlock(workspaceId, outcome, blockId)
  }
}
