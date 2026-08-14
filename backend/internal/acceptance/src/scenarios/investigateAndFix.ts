// Scenario 03: file the defect as a bug report, and let `pl_bugfix` investigate and fix it.
//
// This is the scenario the other three exist to make possible. Everything it needs is now real: two
// services running the shipped feature, a defect nobody planted in the code, and a bug report
// written the way a person would write one: the symptom, and nothing else.
//
// `pl_bugfix` runs bug-investigator → clarity-review (the one human gate) → spec-writer →
// architect → repro-test → coder → reviewer → conflicts → ci → merger. Three things about that
// chain shape this scenario:
//
//   - **The `clarity-review` gate PARKS the run**, and answering it over `/api/v1` is a first-class
//     claim here rather than an obstacle: a headless integration that cannot answer a human gate
//     cannot run this pipeline at all. The suite answers as the REPORTER would, restating the
//     symptom, and never supplies the root cause.
//   - **`repro-test` writes a FAILING test before the fix**, and the platform then runs that test
//     against the pre-fix tree and the pushed tree. Red-then-green is the only thing that proves a
//     bugfix fixed anything, and it is computed by the platform rather than claimed by the agent,
//     which is why it, not the coder's summary, is what this scenario asserts on.
//   - **There is no `deployer` in this pipeline**, so unlike the feature scenario there is no
//     environment evidence to read. Asserting `environments.proof` here would assert
//     `not_applicable`, which is a fact about the pipeline's shape rather than about the run.
//
// The bug is filed under the FRONTEND service, which is both where a reporter sees it and where
// the fix belongs: the backend's contract is documented and internally consistent, so the side
// that disagrees with the documented contract is the caller.

import assert from 'node:assert/strict'
import {
  assertChecks,
  checkCi,
  checkMergeDecision,
  checkNotTruncated,
  checkReproductionProof,
  fileAndDrive,
  requireRunDone,
  retainedEnvironmentUrl,
  type Scenario,
} from '@cat-factory/acceptance-kit'
import type { Harness } from '../harness.ts'
import { bugReportBrief } from '../instructions.ts'
import { filePinnedTask } from '../publicApi.ts'

const PIPELINE = 'pl_bugfix'

// Answered as the reporter, not as someone who knows the answer. It restates what was observed and
// declines to theorise, because the `bug-investigator` diagnosing this from the codebase IS the
// behaviour under test, and a steer naming the offset convention would be the suite marking its own
// homework.
const STEER =
  'I am the person who reported this and I only know what I saw in the browser: page 1 lists ' +
  'Item 1 through Item 10, page 2 starts at Item 10 again and runs to Item 19, and page 3 runs ' +
  'from Item 20 to Item 25. I do not know the cause and have not looked at the code. Every page ' +
  'should show the next 10 items with no repeats.'

export function investigateAndFixScenario(harness: Harness): Scenario {
  const { config, client, world, journal, credentials, epilogue } = harness

  return {
    id: '03-investigate-and-fix',
    title: 'bug lifecycle: investigate the shipped defect and fix it',
    gated: true,
    async run(step) {
      await step(
        'files the bug against the frontend service and drives pl_bugfix to a merged fix',
        async () => {
          const frontend = world.require('frontend')
          const { run, answeredKinds } = await fileAndDrive({
            client,
            journal,
            credentials,
            epilogue,
            existing: world.value.bugfix,
            label: 'the paging bug report',
            // The report names an environment only when the platform says one OUTLIVED its run. Under
            // this suite's own pipeline none does (the feature scenario asserts each `disposer`
            // reclaimed its namespace), so this normally resolves to null and the report says
            // "reproduce locally", which is the truth. It is derived rather than assumed because the
            // alternative reading, a `ready` entry in a settled report, is a deploy-time fact that
            // would send the investigator to a dead host. Resolved inside the callback because a
            // resumed pass that adopts the already filed task must not spend two evidence reads
            // composing a description nobody uses.
            createTask: async () =>
              filePinnedTask(client, config, frontend.serviceId, {
                title: 'Paging repeats the last item of the previous page',
                taskType: 'bug',
                description: bugReportBrief(await liveEnvironmentUrl()),
              }),
            onRecord: (record) => world.patch({ bugfix: record }),
            pipelineId: PIPELINE,
            steer: STEER,
            budgetMs: config.runBudgetMs,
          })
          requireRunDone(run, 'fixing the paging defect')

          // The human gate is a CLAIM, not a side effect: `pl_bugfix` is built around
          // `clarity-review`, and a run that reached `done` without ever parking on it did not
          // exercise the pipeline this scenario names. Asserting it here is what stops a future
          // pipeline change from quietly turning this into a test of an entirely different chain.
          //
          // Read from the LEDGER-BACKED set rather than this attempt's answers: a settled decision
          // looks afterwards exactly like one nobody had to make, so a resumed pass that adopts
          // yesterday's finished run has no way to observe a gate it genuinely answered.
          assert.ok(
            answeredKinds.includes('clarity-review'),
            `the run never parked on the clarity-review gate, so the human-gate path was not ` +
              `exercised (answered: ${answeredKinds.join(', ') || 'nothing'})`,
          )
          journal.finishPhase('the bugfix run merged, having been through the clarity gate')
        },
      )

      await step(
        'proved the defect red on the pre-fix tree and green on the pushed tree',
        async () => {
          const bugfix = world.require('bugfix')
          if (!bugfix.runId) throw new Error('the bugfix run recorded no runId')
          const report = await client.evidence.getReport(bugfix.runId)

          assertChecks('the bugfix run', [
            checkNotTruncated(report),
            ...checkReproductionProof(report),
            ...checkCi(report),
            ...checkMergeDecision(report),
          ])
        },
      )

      await step('recorded an investigation step that produced a diagnosis', async () => {
        const bugfix = world.require('bugfix')
        const run = await client.tasks.getRun(bugfix.taskId)
        const investigator = run.steps.find((entry) => entry.agentKind === 'bug-investigator')

        assert.ok(
          investigator,
          `the run's step chain (${run.steps.map((entry) => entry.agentKind).join(' → ')}) has no ` +
            `'bug-investigator', so it did not run the pipeline this scenario is about`,
        )
        assert.equal(
          investigator.state,
          'done',
          `the bug-investigator step is '${investigator.state}', so the diagnosis every later step ` +
            `builds on was never finished`,
        )
        // Structural, deliberately: that the step produced a deliverable at all. The suite does not
        // grep the diagnosis for the words it hopes to see, since that would test the model's turn of
        // phrase, and the claim that the diagnosis was CORRECT is already made, far more strongly, by
        // the red-then-green reproduction proof above.
        assert.ok(
          (investigator.output?.trim().length ?? 0) > 0,
          'the bug-investigator finished having written nothing, so the triage gate and every step ' +
            'after it built on an empty investigation',
        )
      })
    },
  }

  /** An environment either feature run left STANDING, or null when both were reclaimed. */
  async function liveEnvironmentUrl(): Promise<string | null> {
    for (const key of ['featureFrontend', 'featureBackend'] as const) {
      const record = world.value[key]
      if (!record?.runId) continue
      const url = retainedEnvironmentUrl(await client.evidence.getReport(record.runId))
      if (url) return url
    }
    return null
  }
}
