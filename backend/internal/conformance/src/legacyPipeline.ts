import type { Pipeline } from '@cat-factory/kernel'
import type { ConformanceApp } from './harness.js'

/**
 * Install a pipeline whose SHAPE the authoring rules refuse
 * (`validatePipelineAuthoring` — a chain that tests without deploying, deploys without
 * reclaiming, or reclaims without deploying), by writing the row straight into the store.
 *
 * Those rules bind what a human COMPOSES; they deliberately do not bind the run door, because
 * such a chain stays reachable as STORED state — a pipeline authored before the rule existed, or
 * a workspace's seeded copy of a built-in that predates it. The engine has to keep handling it,
 * and that behaviour is what these suites assert:
 *
 *  - a deploy-only run whose environment OUTLIVES it, torn down by hand (or by the TTL sweep)
 *    afterwards, which is what closes the PR report's teardown leg out of band;
 *  - a test-only run, whose report has to say that no deployer ever stood anything up rather
 *    than render silence as a clean lifecycle.
 *
 * Adding the missing steps to make those saves legal would change the very thing under test, and
 * routing them through `POST /pipelines` asserts the refusal instead of the behaviour. So they
 * are seeded as the legacy state they model. A pipeline the builder WOULD accept is still created
 * through the API, like every other pipeline in these suites.
 */
export async function seedLegacyPipeline(
  app: ConformanceApp,
  workspaceId: string,
  pipeline: Pipeline,
): Promise<string> {
  await app.seedPipeline(workspaceId, pipeline)
  return pipeline.id
}
