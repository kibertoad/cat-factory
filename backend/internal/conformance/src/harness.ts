import type { ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/kernel'
import type { FakeAgentOptions } from './FakeAgentExecutor.js'

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
   * Drive every active run in a workspace to a standstill (done, or parked on a
   * decision / the spend gate) and return the latest executions. In production a
   * durable driver does this (Cloudflare Workflows / pg-boss); the suite drives the
   * engine directly so assertions are deterministic and runtime-independent.
   */
  drive(workspaceId: string, maxRounds?: number): Promise<ExecutionInstance[]>
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
