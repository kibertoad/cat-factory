import {
  AsyncFakeAgentExecutor,
  type ConformanceHarness,
  FakeAgentExecutor,
  RecordingEventPublisher,
  defineConformanceSuite,
  makeIncorporatedReview,
} from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { makeApp } from '../helpers'
import { D1RequirementReviewRepository } from '../../src/infrastructure/repositories/D1RequirementReviewRepository'
import { D1RepoBlueprintRepository } from '../../src/infrastructure/repositories/D1RepoBlueprintRepository'

// Run the shared cross-runtime conformance suite against the Cloudflare Worker
// facade (the real Hono app over a real local D1, inside workerd). The Node
// facade runs the identical suite over real Postgres — together they mandate
// feature parity: a behavioural difference fails the same assertion in one runtime.

const harness: ConformanceHarness = {
  name: 'cloudflare',
  makeApp: (agentOptions) => {
    // Record emitted run snapshots (shared by the start-time container and drive's
    // own container, since it rides the core overrides) so the suite can assert
    // intermediate transitions. Confined to the conformance adapter so the shared
    // `makeApp`/`TestApp` other worker tests use is untouched.
    const recorder = new RecordingEventPublisher()
    const app = makeApp(
      agentOptions?.asyncKinds?.length
        ? new AsyncFakeAgentExecutor(agentOptions)
        : new FakeAgentExecutor(agentOptions),
      { executionEventPublisher: recorder },
    )
    return {
      ...app,
      executionEmits: (blockId) =>
        blockId ? recorder.emits.filter((e) => e.blockId === blockId) : recorder.emits,
      seedIncorporatedReview: (workspaceId, blockId, requirements) =>
        new D1RequirementReviewRepository({ db: env.DB }).upsert(
          workspaceId,
          makeIncorporatedReview(blockId, requirements),
        ),
      seedBlueprint: (record) => new D1RepoBlueprintRepository({ db: env.DB }).upsert(record),
    }
  },
}

defineConformanceSuite(harness)
