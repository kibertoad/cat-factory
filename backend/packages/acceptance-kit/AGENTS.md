# `@cat-factory/acceptance-kit`: building blocks for a headless acceptance suite

What a live-deployment acceptance suite is made of, minus the suite: the scenario driver, the
resumable ledger and progress journal, the prerequisite gate whose refusals carry rendered remedies,
waits that state their last observation, the SDK-driven run driver, and the evidence reductions.
Published, so a deployment can cover its OWN providers, agent kinds and gates without copying the
platform's suite. Full notes: [`README.md`](./README.md).

**Entry:** `src/index.ts`. The two functions a consumer starts from are `runPass` (a whole pass:
banner, scenarios, summary, closing words, exit code) and `runPreflight` / `createPrerequisiteGate`
(the refusal before anything is spent). The worked example is
[`backend/internal/acceptance`](../../internal/acceptance), which is this package's only in-repo
consumer and the reason each rule below exists.

**What this package must NEVER acquire**: a list of prerequisites, a scenario, or a configuration
schema. Each of those is a fact about ONE suite, and a kit that shipped one would be describing the
platform's suite rather than serving any. They ride the four seams: `Prerequisite`, `Scenario`,
`SuiteIdentity`, `CredentialRetry`.

**Nor may the BASE entry point prompt a human**, and the exception is exact: `consoleCredential.ts`
is reachable only through its own `./console-credential` subpath, so `node:tty` stays out of the
import graph of every suite that did not ask for it, including the CI-only ones, for which a prompt
is a hang. It is here rather than in each consumer because what it holds is not a fact about a suite:
it is the platform's own `428` protocol plus the terminal handling whose Windows half fails as a bare
`setRawMode EPERM`. A second such module takes the same shape or does not land.

**`SuiteIdentity` is the deadliest thing to get wrong, and the trap is silence.** Every refusal here
names something only a suite knows: the command that starts a pass, the variable that resumes one,
the file the base URL was typed into. Each of those is OPTIONAL to supply and the kit degrades by
stating less (a probe failure keeps its diagnosis and drops the resume sentence), so a consumer that
forgets one gets prose that is still true and no longer actionable. When adding a refusal, take the
identity where one is available and never invent a default: `npm run acceptance` is a command that
does not exist in most repositories that would install this.

**Shell dialects are decided in ONE table** (`operatorText.ts`'s `DIALECTS`), and a renderer says
what it needs rather than which shell is in play. `VAR=value command` is POSIX syntax that
PowerShell reads as the COMMAND NAME, so a remedy spelled for the wrong shell does not parse, and a
command that does not parse is worse than no command because it is offered as the thing to run.

**Nothing here calls `process.exit`, and nothing writes to stderr.** An afternoon-long pass is piped
to a file, `tee` captures one stream, and `process.exit` tears the process down without draining it:
what that loses is the tail, which is the failure and the summary. `runPass` answers an exit code.

**Where things live**

| File                   | What                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass.ts`              | A whole pass, and the boundary that reports a bug in the suite without losing the run id or the resume.                                             |
| `scenarioRunner.ts`    | The driver: order is the array, bail is the behaviour, the gate runs per gated scenario, no timeout of its own.                                     |
| `preflight.ts`         | Prerequisite vocabulary, the runner that evaluates every one, the refusal, and the gate.                                                            |
| `probeFailure.ts`      | What a THROWN probe was, as three disjoint states with different remedies, and which of the two renderings of a transport failure each reader gets. |
| `deadline.ts`          | The clock. Every wait states its last observation; the outage tolerance is injected, never assumed.                                                 |
| `deploymentOutage.ts`  | Which thrown poll is a restart worth sitting through, for how long, and what one observation of it says.                                            |
| `ledger.ts`            | The resumable ledger, generic over a suite's own fact type. Identity rule, `latest` pointer, `recordsFacts`.                                        |
| `passFiles.ts`         | Where a pass's files live and which passes a directory holds. A relative state dir is resolved ONCE, and REFUSED here.                              |
| `journal.ts`           | The append-only progress record. A write here may never break a pass.                                                                               |
| `client.ts`            | The two SDK clients, the run/decision descriptions, and the poll that returns on an ANSWERABLE decision.                                            |
| `decisions.ts`         | The two kinds answered, what is answerable NOW, and the refusals. The most conservative module here.                                                |
| `runDriver.ts`         | One started run to terminal, under ONE budget spanning every park.                                                                                  |
| `resume.ts`            | File or adopt; the four states a resumed pass can find, plus what a create that never completed leaves behind.                                      |
| `resource.ts`          | The same, for a resource the SUITE provisions: record before observing, adopt over re-provisioning, release on CONFIRMATION.                        |
| `brief.ts`             | The description-cap branch, read from the contracts' own caps. Over the attachment cap it REFUSES rather than cuts.                                 |
| `consoleCredential.ts` | The opt-in `CredentialRetry`: its OWN subpath export, so the base package holds no terminal code.                                                   |
| `evidence.ts`          | Report reductions: a `Check` per claim, so a failing pass reports every unmet one. Provider-NEUTRAL prose throughout.                               |
| `operatorText.ts`      | Describers, scrubbing, and the shell dialect table.                                                                                                 |
| `suiteIdentity.ts`     | Who is running, and the commands rendered from it.                                                                                                  |

**Tests** live beside the sources (`src/*.test.ts`) and need no infrastructure: everything here is
pure over its seams, including the clients (a stubbed `globalThis.fetch`) and the ledger and journal
(a temp directory).

**A transport failure in a test is DRIVEN through a real SDK client** (`src/testing/sdkFailures.ts`,
excluded from the build), never written out by hand. Nothing here calls `fetch` itself, so a bare
undici `TypeError` is a shape no module here can be handed, and the wrapper's message is assembled by
the SDK rather than fixed: the hand-written copies of its previous sentence stayed green through the
release that changed what an operator reads.

**See also:** [`backend/internal/acceptance`](../../internal/acceptance/AGENTS.md),
[`backend/docs/public-api.md`](../../docs/public-api.md), [`sdk/README.md`](../../../sdk/README.md).
