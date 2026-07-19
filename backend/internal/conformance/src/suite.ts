import type { ConformanceHarness } from './harness.js'
import { defineCoreConformance } from './suites/core.js'
import { defineAgentConformance } from './suites/agents.js'
import { defineIntegrationConformance } from './suites/integration.js'
import { defineExecutionConformance } from './suites/execution.js'
import { defineMiscConformance } from './suites/misc.js'

// The cross-runtime conformance suite: the KEY backend behaviour every deployment
// facade must implement identically. It is parameterised by a `ConformanceHarness`,
// so the exact same assertions run against the Cloudflare Worker (over D1, inside
// workerd) and the Node service (over real Postgres). Any behavioural drift between
// runtimes — a repository that maps a column differently, an engine path that only
// one facade wires — fails here instead of shipping silently.
//
// It deliberately covers the runtime-neutral core only (workspaces, board, the
// execution engine driven through the deterministic FakeAgentExecutor). Facade- or
// integration-specific behaviour (GitHub, documents, durable runners, real-time
// upgrade) stays in each runtime's own suite.
//
// The suite is split into contiguous GROUP functions (core / agents / integration /
// execution / misc), one file each under `suites/`, so the Postgres-backed runtimes can
// run each group as its own spec file in parallel (vitest parallelises across files, not
// within one). Each group emits its describes directly; when called standalone they are
// top-level, when called from the aggregate below they nest under one `[name] conformance`
// block. They hold no cross-group state (every register/clear is scoped to its own
// describe), sharing only the pure helpers in `suites/shared.ts`.
export {
  defineCoreConformance,
  defineAgentConformance,
  defineIntegrationConformance,
  defineExecutionConformance,
  defineMiscConformance,
}

// The aggregate the Cloudflare Worker runs (one file → one D1, `singleWorker`): every
// group, each self-wrapping in its own `[name] conformance` describe block. The Postgres
// runtimes instead call the individual group functions from separate spec files so they
// parallelise across vitest workers.
export function defineConformanceSuite(harness: ConformanceHarness): void {
  defineCoreConformance(harness)
  defineAgentConformance(harness)
  defineIntegrationConformance(harness)
  defineExecutionConformance(harness)
  defineMiscConformance(harness)
}
