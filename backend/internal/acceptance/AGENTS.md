# `@cat-factory/acceptance`: the live-deployment acceptance suite

Adopts two empty repositories an operator created, scaffolds a service into each, ships a
cross-service feature onto a real k3s ephemeral environment, then investigates and fixes the defect
that feature leaves behind, against a LIVE local deployment with nothing faked. Full notes:
[`README.md`](./README.md).

**Entry:** `acceptance/*.acceptance.ts` via
`pnpm --filter @cat-factory/acceptance run acceptance`. Needs a running deployment, a k3s cluster
and real model credentials; `src/config.ts` refuses with the whole list of missing VARIABLES, and
`src/prerequisites.ts` then refuses with the whole list of unsatisfied DEPLOYMENT conditions, each
carrying the steps and commands that fix it.

**Setup entry:** `pnpm --filter @cat-factory/acceptance run configure` (`src/configureCli.ts`) writes
that `.env`. Its rule is **resolve rather than ask**: the workspace from `GET /api/v1/me`, the owner
from the VCS connection, the preset from the library joined against the model catalog, the cluster
from the kubeconfig (through `@cat-factory/cli`'s own `readApiServerCommand`/`readTokenCommand`, so
the namespace and secret name are not restated here). What it asks is the API token and the two
repository names, and it then opens each repository's creation page and re-reads
`GET /api/v1/repos` until it sees them. It never overwrites a value without naming it, carries
unmanaged lines over byte for byte, and prints neither token.

**The operator creates the two repositories; the suite ADOPTS them.** `canCreateRepos` is false for
every PAT connection and the App path creates only under `/orgs/{org}/repos`, so bootstrapping was
the one prerequisite no configuration could satisfy. Spec 01 backs a service with each `repoId` and
scaffolds both through `pl_build` from the briefs in `src/instructions.ts`, which is why a scaffold
resumes exactly as a feature run does. `target-repos` gates on the repositories being visible AND
adoptable, and says outright that emptiness is not what it checked: no `/api/v1` read publishes it.
Trap: `serviceId: null` does NOT mean free. A service homed on another board has no id this
workspace-scoped surface can return, so it answers null WITH `linkedElsewhere: true` and
`POST /api/v1/services` refuses; `src/adopt.ts` owns that verdict and the gate shares it. An existing
link is compared against the LEDGER's service ids, never against "is this a resume", since a ledger
holding one of the two services cannot vouch for the other.

**Every task the suite files pins `ACCEPTANCE_MODEL_PRESET`**, through the one door
(`filePinnedTask`), so a pass runs on the model it says it ran on rather than on whatever the
workspace default happens to be. The risk policy is deliberately NOT pinned: `auto-merge-policy`
grades the workspace default, and a pin would make that gate a check on a policy no run uses.

**A pass is watchable and resumable, and both are load-bearing rather than conveniences.**
`pnpm --filter @cat-factory/acceptance run status [runId|latest]` reduces the ledger and the
journal into where a pass got to, opening no connection to the deployment.
`ACCEPTANCE_RUN_ID=<id|latest>` resumes, adopting or re-attaching to whatever the previous attempt
left rather than re-filing it. The README tables both.

**It is NOT in CI and must never become so.** `test:run` points at `vitest.config.ts`, which
collects `test/**/*.test.ts` only: this package's own unit tests. The acceptance specs are behind
`vitest.acceptance.config.ts`, which nothing but the `acceptance` script names. Adding
`acceptance/` to the default include would put real model spend and a cluster requirement into
every CI lane.

**Where things live**

| File                          | What                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `acceptance/00-preflight`     | Reports each prerequisite as its own test. Creates nothing.                                        |
| `acceptance/01-adopt-…`       | k3s engine + a service per adopted repo + each one's manifest source + two `pl_build` scaffolds.   |
| `acceptance/02-feature-…`     | `pl_build` across both services; environment / CI / merge evidence.                                |
| `acceptance/03-investigate-…` | `pl_bugfix`; the `clarity-review` gate answered over `/api/v1`; the repro proof.                   |
| `src/`                        | The harness, plus `configure`. Per-file roles are tabled in the README.                            |
| `test/`                       | Unit tests for the pure logic (config, gate, ledger, journal, status, evidence, waits, configure). |

**The rules the specs are written to** (each expanded in the README, and each the reason a
particular file exists):

0. **Refuse before spending, with the fix attached.** `src/prerequisites.ts` runs in EVERY spec's
   `beforeAll`, not just spec 00: a resumed pass starts where it stopped, so a gate only the first
   file mounts is one the resume path skips. An unreadable probe is its own verdict, never read as
   "unmet". Every negative verdict carries a `Remedy` (numbered steps, pasteable commands, a doc),
   built by the check from what it just READ, so the command holds the real workspace id or account
   rather than a hole. A fix with no CLI names the screen and offers the read that confirms it:
   never a plausible-looking invented command.
1. **Assert on evidence the platform COMPUTED, never on agent prose.** `src/evidence.ts` reduces
   the verification report; grepping a coder's reply tests the model's phrasing, not the product.
2. **Never auto-answer an unplanned decision, and never answer one in FLIGHT.**
   `src/decisions.ts` answers `follow-ups` and `clarity-review` and hard-fails on everything else,
   naming the kind. Which of those two may be acted on NOW is `isActionable`, read off the status
   the platform reports and shared with the poll wait: the list keeps showing a review the driver
   is mid-cycle on, and reading "listed" as "answer me" waives the gate one poll after answering
   it. A loop that settles whatever it finds drives a run past decisions a person was meant to make
   and still ends `done`.
3. **A wait that expires states its last observation.** The vitest timeout is off so
   `src/deadline.ts` fires first.
4. **Report every failing claim, not just the first.** A pass costs an afternoon.

**The defect spec 03 hunts is planted in the SPECIFICATION, not the code.** The two briefs in
`src/instructions.ts` disagree about whether pagination offsets are 0- or 1-based; each service is
correct against its own brief and passes its own review, so the mismatch survives to production the
way a real integration bug does. A defect planted in the implementation would be caught by
`pl_build`'s `reviewer` step and spec 03 would find nothing. **So spec 02 asserts the delivery
machinery worked, never that the product is correct**. That claim is spec 03's, and it is settled
by fixing the bug.

**Changing a brief means re-checking the symptom.** The briefs, the bug report and
`test/evidence.test.ts` describe one specific off-by-one (page 2 repeats item 10, last page short).
Edit the pagination rules and that trace changes, so the bug report has to change with them or the
investigator is handed a symptom the code does not produce.

**Every workspace-scoped call goes through the published SDK**, setup included: the repository list,
backing a service with one, the cluster connection, a service's `provisioning`, the preset pin and
the wiring reads are all `/api/v1` operations. So a surface change that would break an integrator
breaks this suite at compile time, which is most of why it is worth driving the SDK rather than raw
`fetch`.

The only exceptions are `GET /health` and `GET /auth/config` in `src/deploymentApi.ts`, and the
reason is not convenience: both must answer for a deployment whose config failed to validate, which
serves a fallback app that 503s every other route. **A new call does not belong there.** Anything
scoped to a workspace has a key available, so it is a public endpoint, and adding one means adding it
to `routes/public-provisioning.ts` plus `scripts/sdk/surface.mjs` (generation fails without the entry).

**See also:** [`backend/internal/e2e`](../e2e/README.md),
[`backend/internal/sdk-smoketest`](../sdk-smoketest/README.md),
[`backend/docs/public-api.md`](../../docs/public-api.md),
[`backend/docs/local-k3s-environments.md`](../../docs/local-k3s-environments.md).
