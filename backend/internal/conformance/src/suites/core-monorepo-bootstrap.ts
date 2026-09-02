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

/**
 * A deterministic advisor: proposes one decision, evidenced by a file the survey really read.
 *
 * The evidence is picked from the survey it is handed rather than hard-coded, because the
 * platform DROPS a recommendation citing nothing the survey read, and a fake citing a fixed
 * path would silently exercise the drop path instead of the plan path the assertions are about.
 */
function fakeAdvisor(calls?: { count: number }): MonorepoAdoptionAdvisor {
  return {
    enabled: true,
    async advise({ survey }) {
      if (calls) calls.count += 1
      const cited = survey.monorepoPaths[0]
      return {
        model: 'fake:advisor',
        plan: {
          decisions: [
            {
              id: DECISION_ID,
              area: 'testing',
              title: 'Test runner',
              monorepoPractice: 'vitest, configured at the root',
              templatePractice: 'jest, configured per package',
              recommended: 'monorepo',
              rationale: 'The monorepo runs one test runner for every package.',
              evidence: cited ? [`monorepo:${cited}`] : [],
            },
          ],
        },
      }
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

/** The monorepo the suite bootstraps into: root conventions plus one existing sibling service. */
const MONOREPO_FILES: Record<string, string> = {
  'package.json': '{"name":"acme","workspaces":["services/*"]}',
  'pnpm-workspace.yaml': "packages:\n  - 'services/*'\n",
  'vitest.config.ts': 'export default {}',
  'services/billing/package.json': '{"name":"@acme/billing"}',
}

/** The reference template: the same areas, answered differently. */
const TEMPLATE_FILES: Record<string, string> = {
  'package.json': '{"name":"service-template"}',
  'jest.config.js': 'module.exports = {}',
}

export function defineMonorepoBootstrapConformance(harness: ConformanceHarness): void {
  describe('monorepo service bootstrap', () => {
    /**
     * A workspace with `acme/platform` projected as a linked repo, plus a `RepoFiles` resolver
     * that answers for it and for the reference template. `linkFrameRepo` is what puts the repo
     * in the projection on each facade's OWN stores, which is what makes the target resolution
     * below a real cross-runtime read rather than a fixture.
     */
    async function setup(
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

    it('surveys both repositories and parks the run on a human adoption review', async () => {
      const { app, wsId, architectureId } = await setup({ advisor: fakeAdvisor() })

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
      // The survey read the monorepo's root config AND the existing sibling service, which is
      // the read a root-only survey cannot make and the plan is materially weaker without.
      expect(plan.survey.siblingService).toBe('services/billing')
      expect(plan.survey.monorepoPaths).toContain('package.json')
      expect(plan.survey.monorepoPaths).toContain('services/billing/package.json')
      expect(plan.survey.templatePaths).toContain('jest.config.js')
      // Nothing has been written to the monorepo: a parked run has produced no pull request.
      expect(parked.body.prUrl).toBeNull()
      expect(parked.body.adoptionReview).toBeNull()
    })

    it('refuses a review that leaves a decision unanswered, and one for a run that is not parked', async () => {
      const { app, wsId, architectureId } = await setup({ advisor: fakeAdvisor() })
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
      const { app, wsId, architectureId } = await setup({ advisor: fakeAdvisor() })
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
      const { app, wsId, architectureId } = await setup({
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
      const { app, wsId, architectureId, bootstrapper } = await setup({ advisor: fakeAdvisor() })
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
      const { app, wsId, architectureId } = await setup({ advisor: fakeAdvisor(calls) })
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
      const { app, wsId, architectureId } = await setup({
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
      const { app, wsId, architectureId } = await setup({ advisor: fakeAdvisor() })
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
