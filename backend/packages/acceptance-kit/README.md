# `@cat-factory/acceptance-kit`

**Building blocks for writing your own headless acceptance suite against a LIVE cat-factory
deployment.** Real agents, real model spend, real pull requests: the kind of test that proves a
deployment's own providers, agent kinds, gates and pipelines work end to end, on the deployment an
operator actually runs.

The platform's own suite (`backend/internal/acceptance`) is built from this package and is the
worked example. What is here is that suite with the suite taken out.

## What it gives you

| Module              | What                                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scenarioRunner.ts` | The driver: scenarios in the order given, in ONE process, bailing at the first failure, with the prerequisite gate before every gated one.                                                                                                      |
| `preflight.ts`      | The prerequisite vocabulary (`satisfied` / `unsatisfied` / `unknown`, each negative verdict carrying a rendered `Remedy`), the runner that evaluates every one, and the gate that refuses a pass.                                               |
| `probeFailure.ts`   | What a THROWN probe was: never answered (with kernel's transport class, and the SDK's own account of it relayed whole), answered with a refusal (the SDK's status, `code` and request id), or answered by something that is not the deployment. |
| `deadline.ts`       | Waits that state their LAST OBSERVATION when they expire, plus the tolerance that sits through a deployment restart rather than dying on one refused connection.                                                                                |
| `ledger.ts`         | The resumable ledger: a synchronous write per fact, the copied-file refusal, the `latest` pointer, and the "has this pass created anything" rule. Generic over your own fact type.                                                              |
| `journal.ts`        | The append-only progress record, so a pass an operator walked away from can be watched (and read afterwards) from another window.                                                                                                               |
| `client.ts`         | The two SDK clients (fast-refusing before a pass has spent anything, restart-absorbing during one), the descriptions a long wait prints, and the poll that returns on an ANSWERABLE decision.                                                   |
| `decisions.ts`      | Answering `follow-ups` and `clarity-review` and hard-failing on every other kind, which is what stops an unattended loop from driving a run past a decision a person was meant to make.                                                         |
| `runDriver.ts`      | Driving one started run to a terminal state under ONE budget spanning every park.                                                                                                                                                               |
| `resume.ts`         | File a task, or adopt / re-attach to what a previous pass left, recorded at all three points a pass can be interrupted between.                                                                                                                 |
| `resource.ts`       | The same discipline for a RESOURCE your suite provisions itself: recorded before it can be observed, adopted rather than re-provisioned, released only when the provider agrees it is gone.                                                     |
| `brief.ts`          | Getting a real brief onto a task whatever its size: under the description cap it is the description, over it an attached document, and past the attachment cap it is REFUSED rather than cut.                                                   |
| `evidence.ts`       | Reductions over the PR verification report, so a scenario asserts on what the platform COMPUTED rather than on agent prose.                                                                                                                     |
| `pass.ts`           | The pass itself: banner, scenarios, summary, closing words, exit code, and the boundary that reports a bug in the suite without losing the resume.                                                                                              |

One further module is a SEPARATE entry point, `@cat-factory/acceptance-kit/console-credential`, so
the base package stays free of terminal code: `createConsoleCredential()` builds the
`CredentialRetry` half of the seam for a suite whose models run on a person's own subscription,
paired with the request header it fills. Importing that path is the decision to be asked; a
keys-only suite names `passThroughCredentialRetry` and never sees a prompt.

## Writing a suite

```ts
import {
  type Scenario,
  type SuiteIdentity,
  briefFields,
  createPassClient,
  fileAndDrive,
  requireRunDone,
  runPass,
} from '@cat-factory/acceptance-kit'

// 1. Declare who you are. Every refusal the kit prints renders against this, so an operator is told
//    to set YOUR variable and run YOUR command.
const identity: SuiteIdentity = {
  name: 'acme-acceptance',
  runCommand: 'pnpm --filter @acme/acceptance run acceptance',
  runIdVariable: 'ACME_RUN_ID',
  baseUrlVariable: 'ACME_BASE_URL',
  configFile: 'acceptance/.env',
}

// 2. Write scenarios. `gated` is required rather than defaulted: a scenario added without deciding
//    would otherwise spend an afternoon against an unwired deployment.
const shipsAFeature: Scenario = {
  id: '01-ships-a-feature',
  title: 'the custom agent kind builds, opens a PR and merges it',
  gated: true,
  run: async (step) => {
    const { run } = await step('drive', () =>
      fileAndDrive({
        ...options,
        // `briefFields` and not `description: brief`: the description caps at 2,000 characters, a
        // real scaffold brief is several times that, and the ceiling is not a fact your suite
        // should have to know. Under the cap this is byte-for-byte `{ description: brief }`.
        createTask: () =>
          client.tasks.create(serviceId, {
            title: 'Stand up the catalog API',
            ...briefFields({ brief, title: 'Stand up the catalog API' }),
          }),
      }),
    )
    requireRunDone(run, 'the feature run')
  },
}

// 3. Hand them to the pass.
process.exitCode = await runPass({
  identity,
  target: baseUrl,
  ledger,
  journal,
  scenarios: [shipsAFeature],
  gate: () => prerequisites.assert(),
  log: (message) => console.log(message),
  recordsFacts: () => recordsFacts(ledger.value, LEDGER_SLOTS),
})
```

## The rules the kit is built to

Each is a property somebody debugged into existence, and each is why a module here is shaped the way
it is rather than the obvious way.

1. **Refuse before spending, with the fix attached.** A prerequisite is evaluated before EVERY gated
   scenario, not once at the start: a resumed pass begins wherever it stopped, and a budget can be
   spent mid-pass. Every negative verdict carries numbered steps and, where one exists, a pasteable
   command built from what the check just READ.
2. **"Unmet" and "could not be read" are different answers.** A probe that failed is not evidence
   about the thing probed, and reporting it as one sends an operator to fix the wrong thing.
3. **Assert on evidence the platform COMPUTED, never on agent prose.** Grepping a coder's reply
   tests the model's phrasing; swap the model and it goes red having found nothing wrong.
4. **Never auto-answer a decision the suite was not designed for, or one that is in FLIGHT.** A loop
   that settles whatever it finds produces a green suite that proves nothing.
5. **A wait that expires states its last observation, and what the pass left standing.** "Timed out
   after 5400000ms" is true and useless; "step 3 `coder` was still working, 4/9 subtasks" separates a
   parked run from a wedged one from a slow one. The second half is the `epilogue`, required on every
   wait a started run spends its hours in: without it an operator is not told the run, its pull
   request and any provisioned namespace are still there, and they start a second pass that the
   leftovers then refuse.
6. **Report every failing claim, not just the first.** A pass costs an afternoon.
7. **Record an external RESOURCE before anything can observe it, and release it only when the
   provider agrees.** A teardown needs the provider's own id plus whatever the provision captured,
   and neither can be re-derived from the deployment or the repository, so a pass killed between the
   provision returning and the first status poll leaks a machine nothing on disk can name. An
   accepted delete is not a completed one. `resource.ts` is this rule; `PassOptions.onSettled` is
   where its reclaim report goes, so what is still standing lands INSIDE the closing words.
8. **A suite cannot re-create a run's own pull-request environment afterwards.** The merger deletes
   the head branch on merge when it is under the `cat-factory/` prefix, so an environment requested
   by pull-request number resolves a ref the provider no longer has. An environment claim about a
   pull request is read off the run's REPORT (`checkEphemeralEnvironment`); a claim about the
   MERGED code is provisioned fresh from the default branch. Neither half can cover both.

9. **The create itself is the one window a client cannot close, so the pass SAYS which side of it
   the failure fell on.** `fileAndDrive` records a task id on the line after the create, which is as
   early as any client can: if the create's response is lost in transit, the deployment may have made
   the row and the id never reaches the caller, so nothing is recorded and the next pass files a
   second task. That is the same rule as 7 meeting the one state a client cannot observe itself
   entering, and it is not fixable by reordering: closing it needs a caller-supplied idempotency key
   on the `/api/v1` writes that cost real work, which is a permanent shape on a frozen surface and a
   decision of its own. What is fixable is the guessing. A create that failed before any origin
   accepted the request created nothing and a re-run is clean; one that died under the request, timed
   out or came back unreadable may have filed a task with no run started and no budget spent, and
   that one is a refusal telling an operator to look at the board first. The SDK's connection
   diagnosis is what makes the two separable, and its account of the origin (whether this client had
   been answered, and how recently) travels with the instruction.

## Seams

Four things the kit deliberately does NOT decide, because only a suite can:

- **`Prerequisite`**: what a deployment must have wired to run YOUR pass. The kit ships no list; a
  fixed one would refuse over things a deployment testing its own agent kinds has no use for.
- **`Scenario`**: the work itself, and the order.
- **`SuiteIdentity`**: the commands and variables a refusal quotes.
- **`CredentialRetry`**: what to do when the deployment answers `428` because a model is a per-user
  subscription. The kit names the two writes where that can happen and never holds the credential.
  Required on the drive path rather than defaulted, for the reason `gated` is: a suite whose models
  all run on the deployment's own keys passes `passThroughCredentialRetry`, which says so in code,
  where an omission says nothing and surfaces as a pass dying at a `428` after an afternoon of spend.
  The OTHER branch is `@cat-factory/acceptance-kit/console-credential`, opt-in by import.

**CONFIGURATION is the fifth thing the kit does not decide**, and it is listed apart because half of
it is not a seam at all. Reading your own configuration is yours; ASSEMBLING it is a `.env` write,
and the five ways to get that subtly wrong are each a silent failure (the command reports success
and the file means something else). Those five, and the code for them, are
`@cat-factory/cli`'s `envMerge.ts`: keep unmanaged lines VERBATIM, report `kept`/`changed`/`added`/
`preserved` rather than a boolean, quote a value the READER would otherwise disagree about, RECOGNISE
the carried-over header as well as write it, and withhold secrets by an enumerated list rather than a
name pattern. `SuiteIdentity.configFile` is what a refusal names.

## Related

- [`backend/internal/acceptance`](https://github.com/kibertoad/cat-factory/tree/main/backend/internal/acceptance): the platform's own suite, built on this.
- [`backend/docs/public-api.md`](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/public-api.md): the surface every scenario drives.
- [`@cat-factory/sdk`](https://github.com/kibertoad/cat-factory/tree/main/sdk/typescript): the published client the kit builds on.
