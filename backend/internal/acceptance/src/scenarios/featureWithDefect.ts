// Scenario 02: ship a cross-service feature through `pl_build`, onto a real k3s ephemeral environment.
//
// Two tasks, one per service, run in order. Each goes design → implement → review → DEPLOY → test
// → conflicts → CI → merge → DISPOSE, for real: a real container agent writes real code, the
// `deployer` step applies the service's manifests into a fresh namespace on the configured
// cluster, the testers exercise what came up, real GitHub Actions gate the merge, and the
// `disposer` reclaims the namespace as the run settles.
//
// ## What this scenario does and does not claim
//
// It asserts the DELIVERY MACHINERY worked. It deliberately does NOT assert the product is
// correct, because by construction it is not: the two briefs disagree about whether pagination
// offsets count from 0 or from 1 (`src/instructions.ts` explains why the defect is planted in the
// requirements rather than in the code). Each service is internally consistent, passes its own
// review and its own tests, and ships. The defect exists only between them.
//
// That is not a weakness of the scenario, it is its subject. "A feature can be shipped end to end"
// and "the shipped feature is right" are different claims, and only the first is a claim about the
// platform. The second belongs to the bugfix scenario, and is answered by fixing the bug rather than
// by asserting it away.

import assert from 'node:assert/strict'
import {
  assertChecks,
  checkCi,
  checkEphemeralEnvironment,
  checkMergeDecision,
  checkNotTruncated,
  fileAndDrive,
  requireRunDone,
  type RunRecord,
  type Scenario,
} from '@cat-factory/acceptance-kit'
import type { Harness } from '../harness.ts'
import { backendFeatureBrief, frontendFeatureBrief } from '../instructions.ts'
import { hostSuffix } from '../k3s.ts'
import { filePinnedTask } from '../publicApi.ts'

const PIPELINE = 'pl_build'

// The brief is the whole specification, so a question about it is answered by pointing back at it.
// Note what this deliberately does NOT do: volunteer the offset convention the OTHER service uses.
// Supplying that here would resolve the planted mismatch through a side channel and leave the bugfix
// scenario with nothing to find.
const STEER =
  'Implement exactly what the task description specifies, including its stated conventions and ' +
  'worked examples. Do not broaden the scope.'

export function featureWithDefectScenario(harness: Harness): Scenario {
  const { config, client, world, journal, credentials, epilogue } = harness

  return {
    id: '02-feature-with-defect',
    title: 'feature delivery: two services ship through pl_build onto k3s',
    gated: true,
    async run(step) {
      await step('ships the paginated catalog endpoint on the backend service', async () => {
        const backend = world.require('backend')
        const record = await shipFeature({
          ledgerKey: 'featureBackend',
          serviceId: backend.serviceId,
          title: 'Paginate the catalog endpoint',
          brief: backendFeatureBrief(),
        })
        assert.ok(record.pullRequestUrl, 'the backend feature run recorded no pull request')
      })

      await step('ships the paging UI on the frontend service', async () => {
        // Sequential, and only after the backend has MERGED: the frontend brief is written against an
        // endpoint that has to exist. The platform has task-dependency edges for exactly this, but
        // they earn their keep when something ELSE does the starting; here the suite is the
        // scheduler, so ordering it directly is the honest expression of the constraint.
        const frontend = world.require('frontend')
        const record = await shipFeature({
          ledgerKey: 'featureFrontend',
          serviceId: frontend.serviceId,
          title: 'Page through the catalog',
          brief: frontendFeatureBrief(),
        })
        assert.ok(record.pullRequestUrl, 'the frontend feature run recorded no pull request')
      })

      for (const [label, key] of [
        ['backend', 'featureBackend'],
        ['frontend', 'featureFrontend'],
      ] as const) {
        await step(
          `stood the ${label} up on the cluster, gated on real CI, and reclaimed the namespace`,
          async () => {
            const report = await client.evidence.getReport(requireRunId(world.require(key)))

            // Every claim is read off the platform's OWN computed verdicts rather than off agent
            // prose, and they are collected so a failing run reports all of them at once: the
            // difference between one afternoon's debugging and three.
            assertChecks(`the ${label} feature run`, [
              checkNotTruncated(report),
              ...checkEphemeralEnvironment(report),
              ...checkCi(report),
              ...checkMergeDecision(report),
            ])

            // Stated separately because it is the one claim about the CLUSTER rather than about the
            // run: the URL the deployer derived must sit in the domain this suite configured, which
            // is what proves the k3s engine answered rather than some other environment backend.
            const suffix = hostSuffix(config.cluster.ingressHostTemplate)
            const urls = report.environments.entries
              .filter((entry) => entry.status === 'ready')
              .map((entry) => entry.url)
              .filter((url): url is string => Boolean(url))
            assert.ok(
              urls.some((url) => url.includes(suffix)),
              `no ready ${label} environment URL sits under '${suffix}' (from the configured template ` +
                `'${config.cluster.ingressHostTemplate}'). URLs: ${urls.join(', ') || '(none)'}`,
            )
            journal.finishPhase(`the ${label} feature run's delivery evidence holds`)
          },
        )
      }
    },
  }

  /**
   * File a task (or pick up the one a previous pass filed), run it to `done`, record it throughout.
   *
   * The ledger key is threaded in rather than the record, because `fileAndDrive` writes through
   * it three times: at the create, at the start, and at the settle. A pass killed between any two
   * of those re-attaches instead of re-shipping, which here is the difference between a resumed
   * afternoon and a second one.
   */
  async function shipFeature(options: {
    ledgerKey: 'featureBackend' | 'featureFrontend'
    serviceId: string
    title: string
    brief: string
  }): Promise<RunRecord> {
    const { run, answered, record } = await fileAndDrive({
      client,
      journal,
      credentials,
      epilogue,
      existing: world.value[options.ledgerKey],
      label: options.title,
      createTask: () =>
        filePinnedTask(client, config, options.serviceId, {
          title: options.title,
          taskType: 'feature',
          description: options.brief,
        }),
      onRecord: (next) => world.set(options.ledgerKey, next),
      pipelineId: PIPELINE,
      steer: STEER,
      budgetMs: config.runBudgetMs,
    })
    requireRunDone(run, `shipping '${options.title}'`)
    journal.say(
      'milestone',
      `'${options.title}' merged as ${run.pullRequest?.url ?? '(no PR recorded)'} ` +
        `after answering ${answered.length} decision(s)`,
    )
    return record
  }
}

function requireRunId(record: RunRecord): string {
  if (!record.runId) {
    throw new Error(`Task ${record.taskId} has no recorded runId, so its evidence cannot be read.`)
  }
  return record.runId
}
