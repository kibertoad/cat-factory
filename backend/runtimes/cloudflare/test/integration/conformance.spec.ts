import {
  type ConformanceHarness,
  FakeAgentExecutor,
  defineConformanceSuite,
} from '@cat-factory/conformance'
import { makeApp } from '../helpers'

// Run the shared cross-runtime conformance suite against the Cloudflare Worker
// facade (the real Hono app over a real local D1, inside workerd). The Node
// facade runs the identical suite over real Postgres — together they mandate
// feature parity: a behavioural difference fails the same assertion in one runtime.

const harness: ConformanceHarness = {
  name: 'cloudflare',
  makeApp: (agentOptions) => makeApp(new FakeAgentExecutor(agentOptions)),
}

defineConformanceSuite(harness)
