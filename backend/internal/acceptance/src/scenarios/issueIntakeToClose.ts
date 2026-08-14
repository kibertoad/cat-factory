// Scenario 04: somebody outside the team files an issue, and the platform delivers it and closes it.
//
// The loop this scenario exists for is the one a deployment with nobody in the app runs on, end to
// end and with nothing faked:
//
//   1. A REPORTER opens an issue on the backend repository, through the provider's own API with a
//      credential of its own (`src/vcsIssues.ts` explains why that credential is not the platform's).
//   2. `POST /api/v1/services/:serviceId/tasks` files a task FROM that issue, naming it as a
//      `ticket`, which is what makes the platform import it, link it, and hand every agent step the
//      live issue as context.
//   3. `pl_build` delivers it: design, implement, review, CI, and a real merge.
//   4. The platform writes back to the issue and CLOSES it, with nobody having opened a browser.
//
// ## Why it is a separate scenario rather than another step in the feature one
//
// The feature scenario asks whether a brief this suite wrote can be delivered. This one asks whether
// work that arrived from OUTSIDE can be, and the difference is entirely in the parts that one does not
// touch: the ticket import, the linked-issue context, and the writeback. Those are what a headless
// integration is, and every one of them is invisible to a task filed with a `description`.
//
// ## What it asserts, and what it deliberately does not
//
// The claim is the LOOP, not the feature. The issue asks for something small and orthogonal on the
// backend (`offsetValidationIssue` says why), so the delivery evidence asserted here is the same
// machinery the feature scenario already grades: CI went green, the merger resolved an outcome. What
// is new is the pair `checkIssueWriteback` grades, and it is read from the PROVIDER rather than from
// the platform's own report: a closed issue, and the platform's two comments on it.
// `src/issueIntake.ts` explains why the second is what makes the first mean anything.
//
// It does NOT assert the task carried the issue's TEXT into the run. That would test the model's
// reading of a comment thread; what is testable is the LINK, and a `ticket` that failed to resolve
// refuses the creation outright with `details.reason`, so the 201 in step 2 is the claim.
//
// ## Order
//
// Last, and after the bugfix scenario for one reason: it delivers onto the BACKEND repository, which
// the feature scenario merged into and the bugfix one does not touch (its fix belongs to the
// frontend). Running earlier would put two open pull requests on different repositories, which is
// fine, and two runs against the same default branch, which is the collision the ordering exists to
// avoid.

import assert from 'node:assert/strict'
import type { PrReportRunProvider } from '@cat-factory/sdk'
import { assertChecks, checkCi, checkMergeDecision, checkNotTruncated } from '../evidence.ts'
import { type Harness, issueApiFor } from '../harness.ts'
import { offsetValidationIssue } from '../instructions.ts'
import { checkIssueWriteback, fileReporterIssue, waitForIssueSettled } from '../issueIntake.ts'
import { filePinnedTask } from '../publicApi.ts'
import { fileAndDrive } from '../resume.ts'
import { requireRunDone } from '../runDriver.ts'
import type { Scenario } from '../scenarioRunner.ts'
import { ISSUE_SOURCE_BY_PROVIDER, issueTarget, slug } from '../vcsIssues.ts'

const PIPELINE = 'pl_build'

// The issue IS the specification, and it was written by somebody who does not work here, so the
// steer says exactly that and nothing more. It deliberately does not restate the requirement: the
// task's linked issue is what every agent step reads, and paraphrasing it here would test whether
// the suite can write a brief rather than whether the platform can work from a ticket.
const STEER =
  'The linked issue is the specification, and it was filed by an outside reporter. Implement what ' +
  'it asks for and nothing more, and keep every behaviour it says must not change.'

// The writeback fires from the merge hook as a best-effort side effect, so it is normally already
// done by the time the run reports `done`; what this waits out is a provider round trip and, at
// worst, one retry. Deliberately not the run budget: a long wait here would only make a genuinely
// broken writeback take an extra half hour to report.
const WRITEBACK_BUDGET_MS = 3 * 60 * 1000

export function issueIntakeToCloseScenario(harness: Harness): Scenario {
  const { config, client, world, journal, unlock } = harness

  return {
    id: '04-issue-intake-to-close',
    title: 'tracker intake: an outside issue is delivered and closed',
    gated: true,
    async run(step) {
      await step(
        'files an issue on the backend repository as an outside reporter would',
        async () => {
          const target = issueTarget(config)
          const { connection } = await client.vcs.getConnection()
          if (!connection) {
            // Unreachable in practice: `vcs-connection` refuses the pass first. Stated rather than
            // asserted away, because the provider is what decides which client can file at all.
            throw new Error(
              'The workspace has no VCS connection, so there is no provider to file on.',
            )
          }
          const api = issueApiFor(config, connection.provider)
          if (!api) {
            throw new Error(
              `This suite cannot file an issue on '${connection.provider}' (see the issue-credential ` +
                `prerequisite, which refuses the pass with the reason and what would unblock it).`,
            )
          }

          const record = await fileReporterIssue({
            api,
            provider: connection.provider,
            target,
            issue: offsetValidationIssue(),
            existing: world.value.intakeIssue,
            journal,
            onRecord: (next) => world.set('intakeIssue', next),
          })

          // The URL is what the task is linked THROUGH (`ticket.ref` takes a canonical key or a full
          // issue URL), so a record without one is a pass that cannot continue.
          assert.ok(
            record.url.includes(target.repo),
            `the filed issue has no web URL naming '${target.repo}', so nothing can be linked to it ` +
              `(got '${record.url}')`,
          )
          journal.finishPhase(`the reporter's issue is open at ${record.url}`)
        },
      )

      await step(
        'files a task FROM the issue and drives pl_build to a merged delivery',
        async () => {
          const backend = world.require('backend')
          const issue = world.require('intakeIssue')
          const { run, record } = await fileAndDrive({
            client,
            journal,
            unlock,
            existing: world.value.issueDelivery,
            label: `the delivery of ${slug(issue)}#${issue.number}`,
            // `ticket` is the whole point of this scenario. Supplied, the platform imports the issue,
            // projects it, links it to the new task and re-reads it live for every agent step; a ref it
            // cannot resolve refuses this call rather than leaving an unlinked task behind, so a 201 IS
            // the claim that the link exists. The title and description are the caller's own framing,
            // exactly as an integration would send them, and stay short because the issue carries the
            // detail.
            createTask: () =>
              filePinnedTask(client, config, backend.serviceId, {
                title: 'Reject a non-numeric offset on the catalog endpoint',
                taskType: 'feature',
                description:
                  'Filed from a reported issue on the catalog API. The linked issue is the ' +
                  'specification; implement what it asks for without changing the documented clamping ' +
                  'of a numeric out-of-range offset.',
                ticket: { source: ISSUE_SOURCE_BY_PROVIDER[providerOf(issue)], ref: issue.url },
              }),
            onRecord: (next) => world.set('issueDelivery', next),
            pipelineId: PIPELINE,
            steer: STEER,
            budgetMs: config.runBudgetMs,
          })
          requireRunDone(run, `delivering ${slug(issue)}#${issue.number}`)
          assert.ok(
            record.pullRequestUrl,
            'the delivery run reached `done` with no pull request recorded, so there is nothing the ' +
              'writeback could have reported on the issue',
          )
          journal.finishPhase(`the reported issue was delivered as ${record.pullRequestUrl}`)
        },
      )

      await step('gated the delivery on real CI and resolved a merge outcome', async () => {
        const delivery = world.require('issueDelivery')
        if (!delivery.runId) throw new Error('the delivery run recorded no runId')
        const report = await client.evidence.getReport(delivery.runId)

        // The same machinery claims the feature scenario makes, and no environment claim: `pl_build`
        // deploys, but what this scenario is about is the intake and the writeback, and asserting the
        // cluster legs again would make an unrelated k3s wobble read as a broken tracker loop.
        assertChecks('the issue-delivery run', [
          checkNotTruncated(report),
          ...checkCi(report),
          ...checkMergeDecision(report),
        ])
      })

      await step('closed the reporter’s issue and recorded the outcome on it', async () => {
        const issue = world.require('intakeIssue')
        const delivery = world.require('issueDelivery')
        const target = { owner: issue.owner, repo: issue.repo }
        const api = issueApiFor(config, providerOf(issue))
        if (!api) throw new Error(`No issue client for provider '${issue.provider}'`)

        // The wait is on everything the grade below asserts, so a writeback whose merge-edge comment
        // lands a beat after the close is waited out rather than failed. What it hands back is the last
        // state it saw, budget spent or not, because the per-claim detail is the better failure report.
        const state = await waitForIssueSettled({
          api,
          target,
          number: issue.number,
          journal,
          budgetMs: WRITEBACK_BUDGET_MS,
          pullRequestUrl: delivery.pullRequestUrl,
        })

        assertChecks(
          `the writeback on ${slug(target)}#${issue.number}`,
          checkIssueWriteback({ state, pullRequestUrl: delivery.pullRequestUrl }),
        )
        journal.finishPhase(
          `the platform closed ${slug(target)}#${issue.number} and said so on the issue`,
        )
      })
    },
  }
}

/**
 * The provider the ledger's issue was filed on, narrowed to the union the SDK reports.
 *
 * The ledger stores it as a plain string (a hand-edited or older ledger can hold anything), and this
 * is where that widening is undone: an unrecognised value THROWS rather than being cast, because the
 * alternative is asking GitHub's client to read an issue that lives somewhere else.
 */
function providerOf(issue: { provider: string }): PrReportRunProvider {
  if (issue.provider === 'github' || issue.provider === 'gitlab') return issue.provider
  throw new Error(
    `The ledger's issue names provider '${issue.provider}', which this suite has no client for. ` +
      `Delete the 'intakeIssue' record to file a fresh issue, or resume a pass whose provider ` +
      `matches this workspace's connection.`,
  )
}
