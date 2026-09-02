import type {
  AdoptionPlan,
  BootstrapJob,
  MonorepoAdoptionAdvisor,
  RepoFiles,
  Service,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FakeRepoBootstrapper } from '../FakeRepoBootstrapper.js'
import type { ConformanceHarness } from '../harness.js'

// Bootstrapping a new service INTO an existing monorepo: survey both sides, park on a human's
// adoption decisions, then write the service and open a pull request.
//
// What needs pinning across runtimes is not one schema but a SHAPE that only exists here: a run
// with two durable drives and a park between them, whose whole state (the monorepo target, the
// suggested plan, the settled review, the pull request) rides the `agent_runs` `detail` JSON.
// D1 writes it through `json_set(…, json(?))` and Postgres through `jsonb_set(…::jsonb)`, and a
// mismatch in either stores a plan as the TEXT of a plan, which reads back as a parked run whose
// reviewer is shown nothing, on one runtime only. Everything below rides a real store on both.

/** One decision the fake advisor proposes, so the suite can name it in a review. */
const DECISION_ID = 'test-runner'

/** A file the SEED never bodies, so citing it proves the model's own read reached the plan. */
const EXPLORED_PATH = 'services/billing/package.json'

/** One decision, evidenced by whatever key the advisor was actually given for its read. */
function decision(evidence: string[]) {
  return {
    id: DECISION_ID,
    area: 'testing',
    title: 'Test runner',
    monorepoPractice: 'vitest, configured at the root',
    templatePractice: 'jest, configured per package',
    recommended: 'monorepo',
    rationale: 'The monorepo runs one test runner for every package.',
    evidence,
  }
}

/**
 * A deterministic advisor that EXPLORES before it judges: it reads one file the opening context
 * does not carry, and cites the key that read gave it.
 *
 * The evidence comes from the explorer rather than being hard-coded, because the platform DROPS
 * a recommendation citing anything the transcript does not hold as read. That is what makes this
 * fake the right shape: it exercises the whole loop the real advisor runs (fetch, get a citable
 * key back, cite it) without a model, and it fails if the plan is checked against the OPENING
 * snapshot rather than against the transcript the read landed on.
 */
function fakeAdvisor(calls?: { count: number }): MonorepoAdoptionAdvisor {
  return {
    enabled: true,
    async advise({ explorer }) {
      if (calls) calls.count += 1
      const read = await explorer.explore({ side: 'monorepo', kind: 'read', path: EXPLORED_PATH })
      return { model: 'fake:advisor', plan: { decisions: [decision(read.key ? [read.key] : [])] } }
    },
  }
}

/**
 * A `RepoFiles` over a fixed file map, so the survey's reads are the same on every runtime.
 *
 * `bodies` is the pull-request description store the engine's adoption region is spliced into.
 * Seeded with an AGENT-authored body on purpose: the harness lets an agent's own
 * `.cat-pr-description.md` replace the dispatch-time body field-wise, so the region has to
 * survive beside prose the engine did not write, which is the whole reason it is a region.
 */
function fakeRepoFiles(files: Record<string, string>, bodies?: Map<number, string>): RepoFiles {
  return {
    async getFile(path: string) {
      const content = files[path]
      return content === undefined ? null : { content, sha: `sha-${path}` }
    },
    async listDirectory(path: string) {
      const prefix = path ? `${path}/` : ''
      const names = new Set<string>()
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (!rest) continue
        const [head] = rest.split('/')
        if (head) names.add(head)
      }
      return [...names].map((name) => ({
        path: `${prefix}${name}`,
        name,
        type: files[`${prefix}${name}`] === undefined ? 'dir' : 'file',
        sha: `sha-${prefix}${name}`,
      }))
    },
    async headSha() {
      return 'head'
    },
    async createBranch() {},
    async deleteBranch() {},
    async commitFiles() {
      return { commitSha: 'c1', changed: true }
    },
    async openPullRequest() {
      throw new Error('not used by the survey')
    },
    async getPullRequestBody(number: number) {
      return bodies?.get(number) ?? null
    },
    async updatePullRequestBody(number: number, body: string) {
      bodies?.set(number, body)
    },
  } as unknown as RepoFiles
}

/** The monorepo the suite bootstraps into: root conventions plus two existing sibling services. */
const MONOREPO_FILES: Record<string, string> = {
  'package.json': '{"name":"acme","workspaces":["services/*"]}',
  'pnpm-workspace.yaml': "packages:\n  - 'services/*'\n",
  'vitest.config.ts': 'export default {}',
  '.github/workflows/ci.yml': 'name: ci',
  [EXPLORED_PATH]: '{"name":"@acme/billing"}',
  'services/billing/src/index.ts': 'export {}',
  'services/inventory/pom.xml': '<project/>',
}

/** The reference template: the same areas, answered differently. */
const TEMPLATE_FILES: Record<string, string> = {
  'package.json': '{"name":"service-template"}',
  'jest.config.js': 'module.exports = {}',
}

// The fixtures and the two groups below are module-level rather than nested in the exported
// suite: the group outgrew oxlint's per-function budget, and a `describe` body is the one place
// where "extract a collaborator" means hoisting the arrange helpers and splitting the assertions
// by what they are about. The split is the flow's own seam: what the SURVEY produces, and what
// the human REVIEW does with it.

/**
 * A workspace with `acme/platform` projected as a linked repo, plus a `RepoFiles` resolver
 * that answers for it and for the reference template. `linkFrameRepo` is what puts the repo
 * in the projection on each facade's OWN stores, which is what makes the target resolution
 * below a real cross-runtime read rather than a fixture.
 */
async function setup(
  harness: ConformanceHarness,
  options: { advisor?: MonorepoAdoptionAdvisor; prBodies?: Map<number, string> } = {},
) {
  // The bootstrapper both RESOLVES the target repo (the workspace's projection, scoped) and
  // dispatches the apply container, so the suite supplies one fake pre-loaded with the
  // monorepo `acme/platform` at id 777 and nothing else.
  const bootstrapper = new FakeRepoBootstrapper()
  bootstrapper.monorepoRepos.set(777, {
    owner: 'acme',
    name: 'platform',
    installationId: 4242,
    defaultBranch: 'main',
  })
  const app = harness.makeApp(
    {},
    {
      repoBootstrapper: bootstrapper,
      ...(options.advisor ? { monorepoAdoptionAdvisor: options.advisor } : {}),
      resolveRepoFilesForCoords: async (_workspaceId, coords) => {
        const files =
          coords.repo === 'platform'
            ? MONOREPO_FILES
            : coords.repo === 'service-template'
              ? TEMPLATE_FILES
              : null
        if (!files) return null
        return {
          repo: fakeRepoFiles(files, options.prBodies),
          baseBranch: 'main',
          repoId: coords.repo,
          owner: coords.owner,
          name: coords.repo,
        }
      },
    },
  )
  const { workspace } = await app.createWorkspace()
  // A throwaway frame is the vehicle: `linkFrameRepo` writes the workspace's installation
  // AND the repo projection row, which is what a monorepo target must resolve against.
  const frame = await app.call<{ id: string }>('POST', `/workspaces/${workspace.id}/blocks`, {
    title: 'platform',
    type: 'service',
    position: { x: 10, y: 10 },
  })
  await app.linkFrameRepo({
    workspaceId: workspace.id,
    frameBlockId: frame.body.id,
    installationId: 4242,
    githubId: 777,
    owner: 'acme',
    name: 'platform',
  })
  const architecture = await app.call<{ id: string }>(
    'POST',
    `/workspaces/${workspace.id}/bootstrap/reference-architectures`,
    {
      name: 'Service template',
      repoOwner: 'acme',
      repoName: 'service-template',
      defaultInstructions: 'Follow the template.',
    },
  )
  return { app, wsId: workspace.id, architectureId: architecture.body.id, bootstrapper }
}

/** Start a monorepo bootstrap at `services/payments`. */
function start(
  app: Awaited<ReturnType<typeof setup>>['app'],
  wsId: string,
  architectureId: string,
  directory = 'services/payments',
) {
  return app.call<BootstrapJob>('POST', `/workspaces/${wsId}/bootstrap/jobs`, {
    repoName: 'payments',
    referenceArchitectureId: architectureId,
    instructions: 'A payments service.',
    monorepo: { repoGithubId: 777, directory },
  })
}

/**
 * What the survey produces: the read it performs, the budget it answers to, and the transcript
 * the plan is checked against.
 */
function defineSurveyGroup(harness: ConformanceHarness): void {
  describe('the adoption survey', () => {
    it('surveys both repositories and parks the run on a human adoption review', async () => {
      const { app, wsId, architectureId } = await setup(harness, { advisor: fakeAdvisor() })

      const started = await start(app, wsId, architectureId)
      expect(started.status).toBe(201)
      // Nothing is dispatched yet: the survey is the first phase and it runs on the driver.
      expect(started.body.phase).toBe('survey')
      expect(started.body.status).toBe('running')
      expect(started.body.monorepo).toMatchObject({
        repoGithubId: 777,
        repoOwner: 'acme',
        repoName: 'platform',
        directory: 'services/payments',
        branch: null,
      })
      // The board shows the service immediately, as it does for a new-repo bootstrap.
      expect(started.body.blockId).toBeTruthy()

      await app.driveBootstrap(wsId, started.body.id)

      // Re-read through the REPOSITORY, not the start response: this is where a `detail` mapping
      // that stores the plan as text rather than as a nested value would show up.
      const parked = await app.call<BootstrapJob>(
        'GET',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}`,
      )
      expect(parked.body.status).toBe('awaiting_review')
      const plan = parked.body.adoptionPlan as AdoptionPlan
      expect(plan.status).toBe('ready')
      expect(plan.model).toBe('fake:advisor')
      expect(plan.decisions).toHaveLength(1)
      expect(plan.decisions[0]).toMatchObject({ id: DECISION_ID, recommended: 'monorepo' })
      // The survey's SEED read the monorepo's root config and offered EVERY sibling that holds a
      // convention file of its own, which is the read a root-only survey cannot make and what
      // makes a monorepo whose services disagree representable at all.
      expect(plan.survey.siblingServices).toEqual(['services/billing', 'services/inventory'])
      const read = (path: string) => plan.survey.reads.find((entry) => entry.path === path)
      expect(read('monorepo:package.json')).toMatchObject({ origin: 'seed', outcome: 'read' })
      expect(read('template:jest.config.js')).toMatchObject({ origin: 'seed', outcome: 'read' })
      // …and the transcript records what the MODEL went and fetched beside it, which is the whole
      // point: the evidence set is what was read, not what the platform predicted it would need.
      // A plan checked against the OPENING snapshot would drop this decision as invention.
      expect(read(`monorepo:${EXPLORED_PATH}`)).toMatchObject({ origin: 'model', outcome: 'read' })
      expect(plan.decisions[0]?.evidence).toEqual([`monorepo:${EXPLORED_PATH}`])
      expect(plan.survey.exploration).toMatchObject({ calls: 1, exhausted: null })
      // Nothing has been written to the monorepo: a parked run has produced no pull request.
      expect(parked.body.prUrl).toBeNull()
      expect(parked.body.adoptionReview).toBeNull()
    })

    it('bounds the model’s reads, and REPORTS the ceiling rather than ending quietly', async () => {
      // The loop is several vendor round trips where the declared read was one, so the ceiling is
      // the whole cost story. It also has to reach the MODEL and the plan: a survey that stopped
      // because it ran out of budget and one that stopped because the model had seen enough
      // produce the same-looking transcript, and only the first means the plan is missing areas
      // nobody decided not to look at.
      const refusals: string[] = []
      const { app, wsId, architectureId } = await setup(harness, {
        advisor: {
          enabled: true,
          async advise({ explorer, survey }) {
            for (let i = 0; i <= survey.exploration.maxCalls; i++) {
              const answer = await explorer.explore({
                side: 'monorepo',
                kind: 'read',
                path: `services/billing/probe-${i}.json`,
              })
              if (answer.outcome === 'refused') refusals.push(answer.note ?? '')
            }
            const kept = await explorer.explore({
              side: 'monorepo',
              kind: 'read',
              path: EXPLORED_PATH,
            })
            return {
              model: 'fake:advisor',
              plan: { decisions: [decision(kept.key ? [kept.key] : [])] },
            }
          },
        },
      })
      const started = await start(app, wsId, architectureId)
      await app.driveBootstrap(wsId, started.body.id)

      const parked = await app.call<BootstrapJob>(
        'GET',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}`,
      )
      const plan = parked.body.adoptionPlan as AdoptionPlan
      // The refusal is STATED to the model, not thrown at it: the loop still has to end in a
      // plan, and a model that is told what it has left can name the areas it ran short on.
      expect(refusals.length).toBeGreaterThan(0)
      expect(refusals[0]).toContain('exploration budget is spent')
      expect(plan.survey.exploration.exhausted).toBe('calls')
      expect(plan.survey.exploration.calls).toBeGreaterThan(plan.survey.exploration.maxCalls)
      // Past the ceiling nothing further is fetched, so the decision the advisor tried to
      // evidence afterwards cites nothing and the plan says so rather than carrying it.
      expect(plan.status).toBe('unavailable')
      expect(plan.unavailableReason).toBe('analysis_unusable')
      expect(plan.droppedUnevidenced.join(' ')).toContain('cited no file the survey actually read')
    })

    it('drops a recommendation citing anything outside the recorded transcript', async () => {
      // The transcript is what makes the suggestion checkable rather than an assertion, and the
      // check has to hold against a path the model NEVER asked for as much as against one it was
      // told did not exist. Both are the model reasoning from a file it did not see.
      const { app, wsId, architectureId } = await setup(harness, {
        advisor: {
          enabled: true,
          async advise({ explorer }) {
            const absent = await explorer.explore({
              side: 'monorepo',
              kind: 'read',
              path: 'services/billing/never-existed.json',
            })
            expect(absent.outcome).toBe('absent')
            return {
              model: 'fake:advisor',
              plan: {
                decisions: [
                  { ...decision(['monorepo:invented/house-style.yaml']), id: 'invented' },
                  { ...decision(['monorepo:services/billing/never-existed.json']), id: 'absent' },
                ],
              },
            }
          },
        },
      })
      const started = await start(app, wsId, architectureId)
      await app.driveBootstrap(wsId, started.body.id)

      const parked = await app.call<BootstrapJob>(
        'GET',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}`,
      )
      const plan = parked.body.adoptionPlan as AdoptionPlan
      expect(plan.decisions).toEqual([])
      expect(plan.unavailableReason).toBe('analysis_unusable')
      // A read that came back ABSENT is on the transcript precisely because there was nothing
      // behind it, so it is recorded and still not citable.
      expect(
        plan.survey.reads.find(
          (entry) => entry.path === 'monorepo:services/billing/never-existed.json',
        ),
      ).toMatchObject({ origin: 'model', outcome: 'absent' })
      expect(plan.droppedUnevidenced).toHaveLength(2)
    })
  })
}

/** What the human review does with the plan, and what the apply phase does with the review. */
function defineReviewGroup(harness: ConformanceHarness): void {
  describe('the adoption review', () => {
    it('refuses a review that leaves a decision unanswered, and one for a run that is not parked', async () => {
      const { app, wsId, architectureId } = await setup(harness, { advisor: fakeAdvisor() })
      const started = await start(app, wsId, architectureId)

      // Before the survey has parked it, there is no plan to answer.
      const early = await app.call(
        'POST',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}/adoption-review`,
        { choices: [] },
      )
      expect(early.status).toBe(409)
      expect(
        (early.body as { error: { details?: { reason?: string } } }).error.details?.reason,
      ).toBe('bootstrap_not_awaiting_review')

      await app.driveBootstrap(wsId, started.body.id)

      // An EMPTY answer set is refused rather than defaulted onto the recommendation: agreeing
      // with a suggestion and never having read it are the two things this step exists to
      // separate, so a silent default would make the whole park decorative.
      const incomplete = await app.call(
        'POST',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}/adoption-review`,
        { choices: [] },
      )
      expect(incomplete.status).toBe(422)
      const details = (incomplete.body as { error: { details?: Record<string, unknown> } }).error
        .details
      expect(details?.reason).toBe('adoption_review_incomplete')

      // An answer naming a decision this plan does not carry means the reviewer was looking at a
      // different proposal, so it is refused rather than partially applied.
      const unknown = await app.call(
        'POST',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}/adoption-review`,
        { choices: [{ id: 'not-a-decision', choice: 'monorepo' }] },
      )
      expect(unknown.status).toBe(422)
      expect(
        (unknown.body as { error: { details?: { reason?: string } } }).error.details?.reason,
      ).toBe('adoption_choice_unknown')
    })

    it('applies the settled review, opens a pull request, and pins the service to its directory', async () => {
      const { app, wsId, architectureId } = await setup(harness, { advisor: fakeAdvisor() })
      const started = await start(app, wsId, architectureId)
      await app.driveBootstrap(wsId, started.body.id)

      // The reviewer OVERRIDES the suggestion: the stored decision records that, because an
      // agent told only "keep the template's" cannot tell a default from an overruled default.
      const reviewed = await app.call<BootstrapJob>(
        'POST',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}/adoption-review`,
        {
          choices: [
            { id: DECISION_ID, choice: 'template', note: 'This service ships its own runner.' },
          ],
          notes: 'Keep it minimal.',
        },
      )
      expect(reviewed.status).toBe(200)
      expect(reviewed.body.status).toBe('running')
      expect(reviewed.body.phase).toBe('apply')
      expect(reviewed.body.adoptionReview?.decisions[0]).toMatchObject({
        id: DECISION_ID,
        choice: 'template',
        overrodeRecommendation: true,
        note: 'This service ships its own runner.',
      })
      expect(reviewed.body.adoptionReview?.notes).toBe('Keep it minimal.')
      // The apply phase pushes a branch of its own; nothing is force-pushed to the monorepo.
      expect(reviewed.body.monorepo?.branch).toContain(started.body.id)

      await app.driveBootstrap(wsId, started.body.id)

      const done = await app.call<BootstrapJob>(
        'GET',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}`,
      )
      expect(done.body.status).toBe('succeeded')
      // The deliverable is a pull request against a repository that already exists: there is no
      // new repo, and nothing is merged for the reviewer.
      expect(done.body.prUrl).toContain('/acme/platform/pull/')

      // The frame's service is now pinned to the monorepo AT ITS DIRECTORY, which is the linkage
      // `resolveRepoTarget` reads to scope every future agent working on this service. Read
      // through the org catalog so the assertion crosses each facade's own service store.
      const catalog = await app.call<Service[]>('GET', `/workspaces/${wsId}/services/catalog`)
      const service = catalog.body.find((s) => s.frameBlockId === done.body.blockId)
      expect(service?.repoGithubId).toBe(777)
      expect(service?.directory).toBe('services/payments')
    })

    it('parks with a stated reason when no model is wired, instead of an empty plan', async () => {
      // A deployment with no adoption model still gets the DECISION; what it loses is the
      // suggestion. An empty decision list and "the analysis never ran" are opposite facts, and
      // a reviewer shown the first when the second is true would approve a survey nobody made.
      //
      // A DISABLED advisor is what an unwired deployment produces (`createCore` builds one from
      // the model dependencies, and it reports `enabled: false` with no provider), so injecting
      // one is how this drives the unwired path on a harness that does have a fake model.
      const { app, wsId, architectureId } = await setup(harness, {
        advisor: {
          enabled: false,
          advise: () => {
            throw new Error('a disabled advisor must never be called')
          },
        },
      })
      const started = await start(app, wsId, architectureId, 'services/ledger')
      await app.driveBootstrap(wsId, started.body.id)

      const parked = await app.call<BootstrapJob>(
        'GET',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}`,
      )
      expect(parked.body.status).toBe('awaiting_review')
      expect(parked.body.adoptionPlan?.status).toBe('unavailable')
      expect(parked.body.adoptionPlan?.unavailableReason).toBe('model_unavailable')
      expect(parked.body.adoptionPlan?.unavailableDetail).toBeTruthy()
      expect(parked.body.adoptionPlan?.decisions).toEqual([])

      // And the human can still SETTLE it, unaided. This is the only exit from the park (a retry
      // re-enters the same phase), so refusing it left a deployment with no adoption model unable
      // to bootstrap into a monorepo at all, which is the opposite of what an `unavailable` plan
      // is documented to mean. There are no decisions to answer, so the answer set is empty and
      // the reviewer's own notes are what the agent works from.
      const approved = await app.call<BootstrapJob>(
        'POST',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}/adoption-review`,
        { choices: [], notes: 'Follow the monorepo; skip the template CI.' },
      )
      expect(approved.status).toBe(200)
      expect(approved.body.phase).toBe('apply')
      expect(approved.body.adoptionReview?.decisions).toEqual([])
      expect(approved.body.adoptionReview?.notes).toBe('Follow the monorepo; skip the template CI.')

      // …and it really does build: the run reaches its pull request with no suggestion ever made.
      await app.driveBootstrap(wsId, started.body.id)
      const done = await app.call<BootstrapJob>(
        'GET',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}`,
      )
      expect(done.body.status).toBe('succeeded')
      expect(done.body.prUrl).toContain('/pull/')
    })

    it('refuses a directory that already holds a service, and leaves the repo unmarked', async () => {
      // The pre-flight is what stands between a bootstrap and somebody else's work, so it is
      // asserted from the OUTSIDE (no row, no board card) and from the projection's side: the
      // monorepo flag is the thing `resolveRepoTarget` reads to scope every agent working on this
      // repository, so writing it before the refusal would silently re-point every service
      // already pinned there.
      const { app, wsId, architectureId, bootstrapper } = await setup(harness, {
        advisor: fakeAdvisor(),
      })
      const refused = await start(app, wsId, architectureId, 'services/billing')
      expect(refused.status).toBe(409)
      expect(
        (refused.body as { error: { details?: { reason?: string } } }).error.details?.reason,
      ).toBe('monorepo_directory_taken')
      expect(bootstrapper.markedMonorepo).toEqual([])
      const jobs = await app.call<BootstrapJob[]>('GET', `/workspaces/${wsId}/bootstrap/jobs`)
      expect(jobs.body.filter((job) => job.monorepo !== null)).toEqual([])
    })

    it('surveys once when two drives race, so the model call is never paid for twice', async () => {
      // The survey's cost is a vendor call, and both facades' drivers replay: a Workflows step
      // re-run, a pg-boss retry, the stale-run sweeper re-driving a run whose drive died. The
      // guard is an atomic claim taken BEFORE the call, which only a real store can decide, so it
      // is pinned here rather than in a unit test with an in-memory repository.
      const calls = { count: 0 }
      const { app, wsId, architectureId } = await setup(harness, { advisor: fakeAdvisor(calls) })
      const started = await start(app, wsId, architectureId)

      await Promise.all([
        app.driveBootstrap(wsId, started.body.id),
        app.driveBootstrap(wsId, started.body.id),
      ])

      expect(calls.count).toBe(1)
      const parked = await app.call<BootstrapJob>(
        'GET',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}`,
      )
      expect(parked.body.status).toBe('awaiting_review')
      expect(parked.body.adoptionPlan?.decisions).toHaveLength(1)
    })

    it('publishes the settled decisions as a region of the pull request body', async () => {
      // The decisions are the one thing on that pull request the agent did not choose and cannot
      // restate, and the dispatch-time body is NOT where they survive: the harness folds an
      // agent-authored description over it field-wise, and asks the agent to write one whenever
      // the repository ships a PR template. So the engine owns a marker region instead, and what
      // this pins is that the splice preserves the agent's prose on both sides of it.
      // 7 is the number the fake bootstrapper's `prUrl` carries.
      const bodies = new Map<number, string>([[7, 'Agent prose.\n\nWhat this adds and why.']])
      const { app, wsId, architectureId } = await setup(harness, {
        advisor: fakeAdvisor(),
        prBodies: bodies,
      })
      const started = await start(app, wsId, architectureId)
      await app.driveBootstrap(wsId, started.body.id)
      await app.call(
        'POST',
        `/workspaces/${wsId}/bootstrap/jobs/${started.body.id}/adoption-review`,
        {
          choices: [{ id: DECISION_ID, choice: 'template', note: 'Fixes #412 on our board.' }],
        },
      )
      await app.driveBootstrap(wsId, started.body.id)

      const body = bodies.get(7) ?? ''
      expect(body).toContain('Agent prose.')
      expect(body).toContain('<!-- cat-factory:adoption-decisions:start -->')
      expect(body).toContain('Test runner')
      // The reviewer's note is NEUTRALISED, not relayed: a closing keyword before an issue
      // reference would close issue 412 on this monorepo when the bootstrap PR merged.
      expect(body).not.toContain('#412')
      expect(body).toContain('412')
    })

    it('refuses a target repository this workspace has not linked', async () => {
      // The projection is what scopes a monorepo target. Without this, the endpoint would be a
      // way to open a pull request against any repository the deployment's credential reaches.
      const { app, wsId, architectureId } = await setup(harness, { advisor: fakeAdvisor() })
      const refused = await app.call('POST', `/workspaces/${wsId}/bootstrap/jobs`, {
        repoName: 'payments',
        referenceArchitectureId: architectureId,
        instructions: 'A payments service.',
        monorepo: { repoGithubId: 999_999, directory: 'services/payments' },
      })
      expect(refused.status).toBe(404)
    })
  })
}

export function defineMonorepoBootstrapConformance(harness: ConformanceHarness): void {
  describe('monorepo service bootstrap', () => {
    defineSurveyGroup(harness)
    defineReviewGroup(harness)
  })
}
