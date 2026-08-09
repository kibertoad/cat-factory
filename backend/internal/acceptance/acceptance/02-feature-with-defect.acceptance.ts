// Spec 02: ship a cross-service feature through `pl_build`, onto a real k3s ephemeral environment.
//
// Two tasks, one per service, run in order. Each goes design → implement → review → DEPLOY → test
// → conflicts → CI → merge → DISPOSE, for real: a real container agent writes real code, the
// `deployer` step applies the service's manifests into a fresh namespace on the configured
// cluster, the testers exercise what came up, real GitHub Actions gate the merge, and the
// `disposer` reclaims the namespace as the run settles.
//
// ## What this spec does and does not claim
//
// It asserts the DELIVERY MACHINERY worked. It deliberately does NOT assert the product is
// correct, because by construction it is not: the two briefs disagree about whether pagination
// offsets count from 0 or from 1 (`src/instructions.ts` explains why the defect is planted in the
// requirements rather than in the code). Each service is internally consistent, passes its own
// review and its own tests, and ships. The defect exists only between them.
//
// That is not a weakness of the spec, it is its subject. "A feature can be shipped end to end" and
// "the shipped feature is right" are different claims, and only the first is a claim about the
// platform. The second belongs to spec 03, and is answered by fixing the bug rather than by
// asserting it away.

import { describe, expect, it } from 'vitest'
import {
  assertChecks,
  checkCi,
  checkEphemeralEnvironment,
  checkMergeDecision,
  checkNotTruncated,
} from '../src/evidence.ts'
import { backendFeatureBrief, frontendFeatureBrief } from '../src/instructions.ts'
import { hostSuffix } from '../src/k3s.ts'
import { requireRunDone, startAndDrive } from '../src/runDriver.ts'
import type { RunRecord } from '../src/world.ts'
import { harness } from './fixtures.ts'

const PIPELINE = 'pl_build'

// The brief is the whole specification, so a question about it is answered by pointing back at it.
// Note what this deliberately does NOT do: volunteer the offset convention the OTHER service uses.
// Supplying that here would resolve the planted mismatch through a side channel and leave spec 03
// with nothing to find.
const STEER =
  'Implement exactly what the task description specifies, including its stated conventions and ' +
  'worked examples. Do not broaden the scope.'

describe('feature delivery: two services ship through pl_build onto k3s', () => {
  const { config, client, world } = harness()

  it('ships the paginated catalog endpoint on the backend service', async () => {
    const backend = world.require('backend')
    const record = await shipFeature({
      serviceId: backend.serviceId,
      title: 'Paginate the catalog endpoint',
      brief: backendFeatureBrief(),
    })
    world.patch({ featureBackend: record })
    expect(record.pullRequestUrl).toBeTruthy()
  })

  it('ships the paging UI on the frontend service', async () => {
    // Sequential, and only after the backend has MERGED: the frontend brief is written against an
    // endpoint that has to exist. The platform has task-dependency edges for exactly this, but
    // they earn their keep when something ELSE does the starting; here the suite is the
    // scheduler, so ordering it directly is the honest expression of the constraint.
    const frontend = world.require('frontend')
    const record = await shipFeature({
      serviceId: frontend.serviceId,
      title: 'Page through the catalog',
      brief: frontendFeatureBrief(),
    })
    world.patch({ featureFrontend: record })
    expect(record.pullRequestUrl).toBeTruthy()
  })

  it.each([
    ['backend', 'featureBackend'],
    ['frontend', 'featureFrontend'],
  ] as const)(
    'stood the %s up on the cluster, gated on real CI, and reclaimed the namespace',
    async (label, key) => {
      const report = await client.evidence.getReport(requireRunId(world.require(key)))

      // Every claim is read off the platform's OWN computed verdicts rather than off agent prose,
      // and they are collected so a failing run reports all of them at once: the difference
      // between one afternoon's debugging and three.
      assertChecks(`the ${label} feature run`, [
        checkNotTruncated(report),
        ...checkEphemeralEnvironment(report),
        ...checkCi(report),
        ...checkMergeDecision(report),
      ])

      // Stated separately because it is the one claim about the CLUSTER rather than about the
      // run: the URL the deployer derived must sit in the domain this suite configured, which is
      // what proves the k3s engine answered rather than some other environment backend.
      const suffix = hostSuffix(config.cluster.ingressHostTemplate)
      const urls = report.environments.entries
        .filter((entry) => entry.status === 'ready')
        .map((entry) => entry.url)
        .filter((url): url is string => Boolean(url))
      expect(
        urls.some((url) => url.includes(suffix)),
        `no ready ${label} environment URL sits under '${suffix}' (from the configured template ` +
          `'${config.cluster.ingressHostTemplate}'). URLs: ${urls.join(', ') || '(none)'}`,
      ).toBe(true)
    },
  )

  /** File a task, run it to `done`, and record what it produced. */
  async function shipFeature(options: {
    serviceId: string
    title: string
    brief: string
  }): Promise<RunRecord> {
    const task = await client.tasks.create(options.serviceId, {
      title: options.title,
      taskType: 'feature',
      description: options.brief,
    })
    console.log(`  filed '${options.title}' as ${task.taskId}`)

    const { run, answered } = await startAndDrive({
      client,
      taskId: task.taskId,
      pipelineId: PIPELINE,
      steer: STEER,
      budgetMs: config.runBudgetMs,
    })
    requireRunDone(run, `shipping '${options.title}'`)
    console.log(
      `  '${options.title}' merged as ${run.pullRequest?.url ?? '(no PR recorded)'} ` +
        `after answering ${answered.length} decision(s)`,
    )
    return { taskId: task.taskId, runId: run.runId, pullRequestUrl: run.pullRequest?.url ?? null }
  }
})

function requireRunId(record: RunRecord): string {
  if (!record.runId) {
    throw new Error(`Task ${record.taskId} has no recorded runId, so its evidence cannot be read.`)
  }
  return record.runId
}
