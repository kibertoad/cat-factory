import type {
  ExecutionEventPublisher,
  ExecutionInstance,
  RepoBlueprintRecord,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import type { FakeAgentOptions } from './FakeAgentExecutor.js'

/**
 * An {@link ExecutionEventPublisher} that records every run snapshot the engine
 * pushes, deep-cloned at emit time. The suite drives runs directly (no live
 * WebSocket), so this is how it asserts INTERMEDIATE transitions — e.g. that a
 * step's model is already set on the first "spinning up container" emit — which
 * `drive`'s final-state return can't reveal. Each facade harness wires one over the
 * `executionEventPublisher` core override and exposes it via {@link ConformanceApp.executionEmits}.
 */
export class RecordingEventPublisher implements ExecutionEventPublisher {
  readonly emits: ExecutionInstance[] = []

  async executionChanged(_workspaceId: string, instance: ExecutionInstance): Promise<void> {
    // Clone so the engine's later in-place mutations don't rewrite recorded history.
    this.emits.push(structuredClone(instance))
  }

  async boardChanged(): Promise<void> {}
  async bootstrapChanged(): Promise<void> {}
  async notificationChanged(): Promise<void> {}
}

// The seam the conformance suite drives. Each runtime facade implements a
// `ConformanceHarness` over its own composition root (the Cloudflare Worker over
// D1 inside workerd; the Node service over real Postgres) and the suite runs the
// SAME assertions through it — so any behavioural drift between runtimes fails a
// test rather than shipping silently.

export interface TestResponse<T = unknown> {
  status: number
  body: T
}

/**
 * One built application, bound to a runtime's real persistence and a deterministic
 * {@link FakeAgentExecutor}. Mirrors the shape of the Worker's existing `TestApp`
 * so a harness is a thin adapter, not a rewrite.
 */
export interface ConformanceApp {
  /** Issue an HTTP request through the facade's real Hono `app.fetch`. */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<TestResponse<T>>
  /** Create (and optionally seed) a workspace, returning its snapshot. */
  createWorkspace(options?: { name?: string; seed?: boolean }): Promise<WorkspaceSnapshot>
  /**
   * Create an unseeded workspace owned by an ORG account (a fresh org + owner created
   * straight through the facade's services, since dev-open has no signed-in user to
   * drive the HTTP account flow). Backs the conformance assertion that an individual-only
   * subscription (Claude) is refused for org-owned workspaces on every runtime.
   */
  createOrgWorkspace(options?: { name?: string }): Promise<WorkspaceSnapshot>
  /**
   * Drive every active run in a workspace to a standstill (done, or parked on a
   * decision / the spend gate) and return the latest executions. In production a
   * durable driver does this (Cloudflare Workflows / pg-boss); the suite drives the
   * engine directly so assertions are deterministic and runtime-independent.
   */
  drive(workspaceId: string, maxRounds?: number): Promise<ExecutionInstance[]>
  /**
   * Poll a bootstrap run to a terminal state (the Node/CF facades durably drive this via
   * pg-boss / a BootstrapWorkflow; the suite drives it directly against a deterministic
   * {@link FakeRepoBootstrapper}). Returns the number of polls taken.
   */
  driveBootstrap(workspaceId: string, jobId: string, maxPolls?: number): Promise<number>
  /**
   * Every {@link ExecutionInstance} the engine emitted (via `executionChanged`), in
   * order and deep-cloned at emit time — so the suite can assert intermediate
   * transitions `drive`'s final state can't show. Optionally filtered to one block.
   */
  executionEmits(blockId?: string): ExecutionInstance[]
  /**
   * Seed an already-"incorporated" requirements review for a block straight into the
   * facade's real review store, so the suite can assert the engine substitutes the
   * reworked requirements into the agent context — on EVERY runtime, not just the one
   * a feature-specific spec happens to cover. (The review/rework run themselves call a
   * real LLM, so the suite seeds the persisted outcome rather than driving them.)
   */
  seedIncorporatedReview(workspaceId: string, blockId: string, requirements: string): Promise<void>
  /**
   * Seed a persisted repository blueprint straight into the facade's real board-scan
   * store, so the suite can assert the blueprint read endpoints (which the manual scan
   * + the blueprint pipeline step write) return it identically on every runtime —
   * without running a real container scan.
   */
  seedBlueprint(record: RepoBlueprintRecord): Promise<void>
}

export interface ConformanceHarness {
  /** Label used in test names + skip diagnostics, e.g. `'cloudflare'` or `'node'`. */
  name: string
  /**
   * Build an app wired with a deterministic agent. `agentOptions` are forwarded to
   * the shared {@link FakeAgentExecutor}; the durable runner is replaced with a
   * no-op so the suite advances runs itself via {@link ConformanceApp.drive}.
   */
  makeApp(agentOptions?: FakeAgentOptions): ConformanceApp
}
