import type { CatFactoryClient } from '@cat-factory/sdk'
import { describe, expect, it } from 'vitest'
import { unreachableRepoSteps } from '../src/adopt.ts'
import type { AcceptanceConfig } from '../src/config.ts'
import { envAssignment, perPersonPrefixInvocation, resumeInvocation } from '../src/operatorText.ts'
import type { PrerequisiteVerdict, Remedy } from '../src/preflight.ts'
import { type PreflightContext, PREREQUISITES } from '../src/prerequisites.ts'
import type { IssueApi, IssueCredentialVerdict } from '../src/vcsIssues.ts'

// What is pinned here is that a refusal is ACTIONABLE, which is a different property from being
// correct: `test/preflight.test.ts` covers the disposition logic, and these cover the instructions
// each check hands back.
//
// The rule worth a test rather than a comment is that a remedy is built from what the probe just
// READ. A generic "point the suite at the right workspace" is what these replaced, and it is the
// version that survives refactoring unnoticed, because nothing fails when the value stops being
// substituted. So each case below asserts the command carries the id, account or template the
// fake deployment answered with.

function config(overrides: Partial<AcceptanceConfig> = {}): AcceptanceConfig {
  return {
    baseUrl: 'http://127.0.0.1:8787',
    apiKey: 'cf_live_test',
    workspaceId: 'ws_intended',
    repoOwner: 'intended-org',
    namePrefix: 'cf-acc',
    repos: { backend: 'cf-acc-catalog-api', frontend: 'cf-acc-catalog-web' },
    modelPresetId: 'mdp_claude',
    cluster: {
      apiServerUrl: 'https://127.0.0.1:6443',
      apiToken: 'sa-token',
      caCertPem: null,
      insecureSkipTlsVerify: true,
      ingressHostTemplate: '{{namespace}}.127.0.0.1.nip.io',
      namespaceTemplate: 'cf-acc-{{pullNumber}}',
    },
    vcs: { token: 'reporter-token', apiBaseUrl: 'https://api.github.com' },
    stateDir: '.acceptance',
    runBudgetMs: 60_000,
    ...overrides,
  }
}

/**
 * The reporter's issue client, faked at the seam the context takes it through.
 *
 * A verdict rather than a `fetch` fake, because what these cases pin is how the GATE reacts to each
 * verdict: the four-way mapping from a provider's answer to instructions. Whether the client reads a
 * 404 as `unreachable` is `test/vcsIssues.test.ts`'s claim, over the transport.
 */
function issueApiFor(verdict: IssueCredentialVerdict): PreflightContext['issueApiFor'] {
  return () =>
    ({
      probe: async () => verdict,
      file: async () => {
        throw new Error('the gate must not FILE anything')
      },
      read: async () => null,
    }) satisfies IssueApi
}

/** Run one prerequisite against a fake deployment and assert it refused, returning the verdict. */
async function refusal(
  id: string,
  context: Partial<PreflightContext>,
): Promise<Extract<PrerequisiteVerdict, { status: 'unsatisfied' }>> {
  const prerequisite = PREREQUISITES.find((entry) => entry.id === id)
  if (!prerequisite) throw new Error(`no prerequisite '${id}'`)
  const verdict = await prerequisite.check({
    config: config(),
    serviceTitles: [],
    adoptedServiceIds: [],
    issueApiFor: issueApiFor({ status: 'ready' }),
    ...context,
  } as PreflightContext)
  if (verdict.status !== 'unsatisfied') {
    throw new Error(`expected '${id}' to refuse, got '${verdict.status}'`)
  }
  assertActionable(id, verdict.remedy)
  return verdict
}

/** Run one prerequisite and assert it was SATISFIED, returning its detail line. */
async function satisfied(id: string, context: Partial<PreflightContext>): Promise<string> {
  const prerequisite = PREREQUISITES.find((entry) => entry.id === id)
  if (!prerequisite) throw new Error(`no prerequisite '${id}'`)
  const verdict = await prerequisite.check({
    config: config(),
    serviceTitles: [],
    adoptedServiceIds: [],
    issueApiFor: issueApiFor({ status: 'ready' }),
    ...context,
  } as PreflightContext)
  if (verdict.status !== 'satisfied') {
    throw new Error(
      `expected '${id}' to pass, got '${verdict.status}': ` +
        `${verdict.status === 'unsatisfied' ? verdict.problem : verdict.probeFailure}`,
    )
  }
  return verdict.detail
}

/**
 * Run one prerequisite and assert it reported UNKNOWN: it could not read an answer.
 *
 * The third state `preflight.ts` exists for, and worth its own helper beside the two above because
 * the property is easy to lose: a probe that cannot reach a provider must not be reported as
 * evidence the credential is bad, and nothing about a refusal's shape says so.
 */
async function unreadable(
  id: string,
  context: Partial<PreflightContext>,
): Promise<Extract<PrerequisiteVerdict, { status: 'unknown' }>> {
  const prerequisite = PREREQUISITES.find((entry) => entry.id === id)
  if (!prerequisite) throw new Error(`no prerequisite '${id}'`)
  const verdict = await prerequisite.check({
    config: config(),
    serviceTitles: [],
    adoptedServiceIds: [],
    issueApiFor: issueApiFor({ status: 'ready' }),
    ...context,
  } as PreflightContext)
  if (verdict.status !== 'unknown') {
    throw new Error(`expected '${id}' to report unknown, got '${verdict.status}'`)
  }
  assertActionable(id, verdict.remedy)
  return verdict
}

/**
 * The floor every remedy meets, checked on each one these tests produce.
 *
 * The angle-bracket rule is the design rule made mechanical: a check that has already read the
 * value has no excuse for handing back a hole for the reader to fill, and a `<workspace-id>` in a
 * pasted command fails in a shell rather than being noticed as a placeholder.
 */
function assertActionable(id: string, remedy: Remedy): void {
  expect(remedy.steps.length, `${id} answered a remedy with no step`).toBeGreaterThan(0)
  for (const command of remedy.commands ?? []) {
    expect(command.purpose.length, `${id}: '${command.run}' has no purpose`).toBeGreaterThan(0)
    expect(command.run, `${id}: '${command.run}' still holds a placeholder`).not.toMatch(
      /<[a-z-]+>/,
    )
  }
}

const commandsOf = (remedy: Remedy) => (remedy.commands ?? []).map((command) => command.run)

describe('deployment-health', () => {
  const deployment = (status: string, problems: unknown[] = []) =>
    ({
      health: async () => ({ status }),
      configProblems: async () => problems,
    }) as unknown as PreflightContext['deployment']

  it("relays the deployment's own per-variable remedy and doc link rather than paraphrasing", async () => {
    // The backend already writes the better message: it names the variable, what breaks without
    // it, and the exact command that produces a value. A paraphrase here would be a second copy
    // of it, one release behind.
    const verdict = await refusal('deployment-health', {
      deployment: deployment('misconfigured', [
        {
          key: 'ENCRYPTION_KEY',
          summary: 'Seals every per-workspace credential at rest.',
          remedy: 'Generate one with `openssl rand -base64 32`.',
          docsUrl: 'https://www.catfactory.ai/reference/environment-variables.html',
        },
      ]),
    })
    expect(verdict.remedy.steps[0]).toContain('openssl rand -base64 32')
    expect(verdict.remedy.steps[0]).toContain(
      'https://www.catfactory.ai/reference/environment-variables.html',
    )
    expect(verdict.remedy.steps.at(-1)).toContain('RESTART')
  })

  it('says so when a misconfigured deployment publishes no problem list', async () => {
    // "Absent" and "nothing wrong" must not render the same: an empty list here means the
    // diagnosis has to come from the boot log, and the remedy is the only place that is said.
    const verdict = await refusal('deployment-health', { deployment: deployment('misconfigured') })
    expect(verdict.remedy.steps[0]).toContain('boot log')
  })

  it('names the SPA-vs-backend mixup for a health verdict that is neither ok nor misconfigured', async () => {
    const verdict = await refusal('deployment-health', { deployment: deployment('degraded') })
    expect(verdict.remedy.steps.join('\n')).toContain('CAT_FACTORY_BASE_URL')
  })
})

describe('api-key', () => {
  const client = (identity: Record<string, unknown>) =>
    ({ me: { get: async () => identity } }) as unknown as CatFactoryClient

  it('offers the id the key actually names, so the fix is one paste', async () => {
    const verdict = await refusal('api-key', {
      client: client({ workspaceId: 'ws_other', scope: 'admin', keyId: 'k1', label: 'mine' }),
    })
    expect(commandsOf(verdict.remedy)).toContain(
      envAssignment('ACCEPTANCE_WORKSPACE_ID', 'ws_other'),
    )
  })

  it('sends an under-scoped key to be re-minted, since a scope cannot be raised in place', async () => {
    const verdict = await refusal('api-key', {
      client: client({ workspaceId: 'ws_intended', scope: 'write', keyId: 'k1', label: 'mine' }),
    })
    expect(verdict.remedy.steps.join('\n')).toContain("'write'")
    expect(verdict.remedy.steps.join('\n')).toContain('Full access')
    // No invented command: minting a token is a console action, and the only command it earns is
    // the read that confirms the new one.
    expect(commandsOf(verdict.remedy).join('\n')).toContain('/api/v1/me')
  })
})

describe('agent-model', () => {
  const client = (models: Record<string, unknown>[]) =>
    ({
      models: { list: async () => ({ models, excludesUserScopedModels: false }) },
    }) as unknown as CatFactoryClient

  it('names the POLICY when it refuses the whole catalog, even with a connected subscription', async () => {
    // The two causes can hold at once, and only one of them can be acted on. Reaching the identity
    // answer first announced "Nothing is missing from the deployment" about a deployment whose
    // model-family policy refuses every entry, and pointed at a re-mint that changes nothing.
    const verdict = await refusal('agent-model', {
      client: client([
        {
          modelId: 'claude-opus',
          label: 'Claude',
          available: false,
          policyBlocked: true,
          personalSubscription: true,
          subscriptionConfigured: true,
        },
        { modelId: 'gpt-5', label: 'GPT', available: false, policyBlocked: true },
      ]),
    })
    expect(verdict.problem).toContain('model-family policy')
    expect(verdict.problem).not.toContain('Nothing is missing from the deployment')
  })

  it('names the token when a connected subscription is what the catalog is missing', async () => {
    // The same read with the policy out of the way: now the deployment IS correct and the token's
    // identity is the whole problem, which is the one refusal here whose remedy is not "wire
    // something".
    const verdict = await refusal('agent-model', {
      client: client([
        {
          modelId: 'claude-opus',
          label: 'Claude',
          available: false,
          policyBlocked: false,
          personalSubscription: true,
          subscriptionConfigured: true,
        },
      ]),
    })
    expect(verdict.problem).toContain('Nothing is missing from the deployment')
    expect(verdict.remedy.steps.join('\n')).toContain('"Runs as" set to yourself')
  })
})

describe('model-preset', () => {
  const client = (
    presets: Record<string, unknown>[],
    models: Record<string, unknown>[] = [
      { modelId: 'claude-opus', label: 'Claude', available: true },
    ],
  ) =>
    ({
      modelPresets: { list: async () => ({ presets }) },
      models: { list: async () => ({ models, excludesUserScopedModels: false }) },
    }) as unknown as CatFactoryClient

  const preset = (overrides: Record<string, unknown> = {}) => ({
    presetId: 'mdp_claude',
    name: 'Claude Opus 5',
    baseModelId: 'claude-opus',
    isDefault: true,
    overrides: {},
    ...overrides,
  })

  it('lists the ids the deployment actually has when the pinned one is not among them', async () => {
    // The whole remedy: an operator who typed a name or a slug needs the id, and the deployment is
    // the only thing that knows it.
    const verdict = await refusal('model-preset', {
      client: client([preset({ presetId: 'mdp_kimi', name: 'Kimi K2.7', baseModelId: 'kimi' })]),
    })
    expect(verdict.remedy.steps.join('\n')).toContain('mdp_kimi')
    expect(verdict.remedy.steps.join('\n')).toContain("'Kimi K2.7'")
  })

  it('separates a preset naming a model the catalog dropped from one nobody wired', async () => {
    // Different fixes: the first is a preset to edit, the second is a provider to wire. Rolling
    // them together sends someone to add a key for a model id that no longer exists.
    const gone = await refusal('model-preset', {
      client: client([preset({ baseModelId: 'claude-opus-4' })]),
    })
    expect(gone.problem).toContain('catalog does not list')

    const unwired = await refusal('model-preset', {
      client: client([preset()], [{ modelId: 'claude-opus', label: 'Claude', available: false }]),
    })
    expect(unwired.problem).toContain('not selectable')
    expect(unwired.remedy.steps.join('\n')).toContain('Model providers')
  })

  it('names a CONNECTED subscription in the headline rather than calling it unwired', async () => {
    // The first line is what an operator reads and acts on, so a model the deployment has just
    // confirmed is wired must not be announced as having no provider. The remedy is a token, and
    // there is deliberately nothing about wiring a provider underneath it: nothing is unwired.
    const verdict = await refusal('model-preset', {
      client: client(
        [preset()],
        [
          {
            modelId: 'claude-opus',
            label: 'Claude',
            available: false,
            personalSubscription: true,
            subscriptionConfigured: true,
          },
        ],
      ),
    })
    expect(verdict.problem).toContain('IS connected for this token’s owner')
    const steps = verdict.remedy.steps.join('\n')
    expect(steps).toContain('"Runs as" set to yourself')
    expect(steps).not.toContain('Model providers')
  })

  it('sends a policy-refused model to the policy rather than to a provider key', async () => {
    const verdict = await refusal('model-preset', {
      client: client(
        [preset()],
        [{ modelId: 'claude-opus', label: 'Claude', available: false, policyBlocked: true }],
      ),
    })
    expect(verdict.problem).toContain('model-family policy')
    expect(verdict.remedy.steps.join('\n')).toContain('adding a provider key changes nothing')
  })

  it('keeps the policy ahead of a subscription the deployment CONFIRMED is connected', async () => {
    // Both facts are true of this row, and only one of them can be acted on: a re-minted token
    // spends the subscription and the policy refuses the model anyway. Ranking the identity answer
    // first told an operator nothing was missing from a deployment whose policy was the problem.
    const verdict = await refusal('model-preset', {
      client: client(
        [preset()],
        [
          {
            modelId: 'claude-opus',
            label: 'Claude',
            available: false,
            policyBlocked: true,
            personalSubscription: true,
            subscriptionConfigured: true,
          },
        ],
      ),
    })
    expect(verdict.problem).toContain('model-family policy')
    expect(verdict.problem).not.toContain('IS connected')
  })

  it('says the owner holds NONE rather than calling the question unanswerable', async () => {
    // `false` is the deployment's own answer: it resolved the person and they hold no subscription
    // for the vendor. Folding it into the `null` wording ("this token resolved none, so whether it
    // is wired is unknown here") reported an ANSWERED question as unanswerable and sent the reader
    // to re-mint a token that would resolve the same person and the same absence.
    const verdict = await refusal('model-preset', {
      client: client(
        [preset()],
        [
          {
            modelId: 'claude-opus',
            label: 'Claude',
            available: false,
            personalSubscription: true,
            subscriptionConfigured: false,
          },
        ],
      ),
    })
    expect(verdict.problem).toContain('holds none for that vendor')
    expect(verdict.problem).not.toContain('unknown here')
    const steps = verdict.remedy.steps.join('\n')
    expect(steps).toContain('re-minting the token changes nothing')
    expect(steps).not.toContain('"Runs as" set to yourself')
  })

  it('offers only presets whose model IS selectable as the alternative', async () => {
    // A remedy that offered an equally undispatchable preset has sent the reader round the same
    // loop, so the alternative is joined against the catalog rather than read off the library.
    const verdict = await refusal('model-preset', {
      client: client(
        [preset(), preset({ presetId: 'mdp_kimi', name: 'Kimi', baseModelId: 'kimi' })],
        [
          { modelId: 'claude-opus', label: 'Claude', available: false },
          { modelId: 'kimi', label: 'Kimi', available: true },
        ],
      ),
    })
    const steps = verdict.remedy.steps.join('\n')
    expect(steps).toContain("mdp_kimi ('Kimi')")
    expect(steps).not.toContain("mdp_claude ('Claude Opus 5')")
  })

  it('states the per-kind override count, so a surprising dispatch model is not a surprise', async () => {
    const detail = await satisfied('model-preset', {
      client: client([preset({ overrides: { coder: 'kimi' } })]),
    })
    expect(detail).toContain('1 per-kind override')
  })
})

describe('vcs-connection', () => {
  const client = (connection: Record<string, unknown> | null) =>
    ({ vcs: { getConnection: async () => ({ connection }) } }) as unknown as CatFactoryClient

  const connected = (overrides: Record<string, unknown> = {}) => ({
    accountLogin: 'intended-org',
    provider: 'github',
    method: 'app',
    canCreateRepos: false,
    canManageWorkflows: true,
    ...overrides,
  })

  it('offers the connected account as the other way to resolve an owner mismatch', async () => {
    const verdict = await refusal('vcs-connection', {
      client: client(connected({ accountLogin: 'someone-else' })),
    })
    expect(commandsOf(verdict.remedy)).toContain(
      envAssignment('ACCEPTANCE_REPO_OWNER', 'someone-else'),
    )
  })

  it('passes a connection that cannot create repositories, which the operator now does', async () => {
    // The prerequisite no configuration could satisfy: `VcsPatConnectionService` hard-codes
    // `canCreateRepos: false` for every PAT connection, so this gate refused the deployment shape
    // the README offers first. Adopting operator-created repositories is what retired it, and this
    // is the assertion that stops it being reintroduced.
    const detail = await satisfied('vcs-connection', { client: client(connected()) })
    expect(detail).toContain('workflow')
  })

  it('still refuses a connection that cannot write workflow files', async () => {
    const verdict = await refusal('vcs-connection', {
      client: client(connected({ canManageWorkflows: false })),
    })
    expect(verdict.remedy.steps.join('\n')).toContain('Workflows: read and write')
  })

  it('names the workflow permission when nothing is connected at all', async () => {
    const verdict = await refusal('vcs-connection', { client: client(null) })
    expect(verdict.remedy.steps.join('\n')).toContain('workflow')
  })
})

describe('target-repos', () => {
  /**
   * A deployment holding `linked` repositories, and (optionally) `reachable` ones it has not adopted.
   *
   * Two populations rather than one, because that split is what this gate now reads: `GET /api/v1/repos`
   * answers what the workspace links, and `GET /api/v1/repos/available` what its connection can reach.
   * The available read FILTERS on the query, as the deployment's does (`owner/name` is point-read and
   * a shorter string is searched), so a fake cannot pass a test the real endpoint would fail by
   * answering with everything: the gate's slug query must not surface a look-alike under another owner,
   * and its name query must.
   */
  const client = (linked: Record<string, unknown>[], reachable: Record<string, unknown>[] = []) =>
    ({
      repos: {
        list: async () => ({ repos: linked }),
        listAvailable: async ({ q }: { q?: string }) => ({
          repos: reachable.filter((row) => !q || `${row.owner}/${row.name}`.includes(q)),
          truncated: false,
        }),
      },
    }) as unknown as CatFactoryClient

  const repo = (name: string, overrides: Record<string, unknown> = {}) => ({
    owner: 'intended-org',
    name,
    repoId: 1,
    serviceId: null,
    linkedElsewhere: false,
    monorepo: false,
    private: true,
    provider: 'github',
    defaultBranch: 'main',
    ...overrides,
  })

  const both = () => [repo('cf-acc-catalog-api'), repo('cf-acc-catalog-web')]

  it('names BOTH unreachable repositories, not just the first', async () => {
    const verdict = await refusal('target-repos', { client: client([]) })
    expect(verdict.problem).toContain('cf-acc-catalog-api')
    expect(verdict.problem).toContain('cf-acc-catalog-web')
    expect(commandsOf(verdict.remedy)[0]).toContain('run configure')
  })

  it('passes a repository the connection can reach but nobody has adopted', async () => {
    // The state a hand-written `.env` starts in, and it is not a refusal: spec 01 adopts a reachable
    // repository itself through `POST /api/v1/repos/link`. Gating on the LINKED list alone would
    // refuse a setup that is complete, and would make `configure` the only supported way in.
    const detail = await satisfied('target-repos', { client: client([], both()) })
    expect(detail).toContain('reachable but not adopted yet')
    expect(detail).toContain('spec 01')
  })

  it('reports the two populations separately, since only the adopted one has been checked', async () => {
    const detail = await satisfied('target-repos', {
      client: client([repo('cf-acc-catalog-api')], [repo('cf-acc-catalog-web')]),
    })
    expect(detail).toContain('intended-org/cf-acc-catalog-api are adopted')
    expect(detail).toContain('intended-org/cf-acc-catalog-web is reachable but not adopted')
  })

  it('searches the NAME when the slug misses, since a look-alike is what tells the two apart', async () => {
    // The distinction neither read can make and the operator has to: a repository outside a GitHub
    // App's installation is missing exactly as one that was never created is. What separates them in
    // practice is a same-named repository under another owner, and only a name search can surface one
    // (a search for `intended-org/foo` does not match `someone-else/foo`).
    const verdict = await refusal('target-repos', {
      client: client([], [repo('cf-acc-catalog-api', { owner: 'someone-else' })]),
    })
    expect(verdict.problem).toContain('someone-else/cf-acc-catalog-api')
    expect(verdict.remedy.steps.join('\n')).toContain("'cf-acc-catalog-api' under 'someone-else'")
  })

  it('asks for creation and access, never for linking, since the pass links for itself', async () => {
    // The steps cover only what no API can do on an operator's behalf. A remedy telling someone to
    // open the app's repository picker would be asking for a step the suite performs itself.
    const verdict = await refusal('target-repos', { client: client([]) })
    const steps = verdict.remedy.steps.join('\n')
    expect(steps).toContain('create them EMPTY except for a README')
    expect(steps).toContain('POST /api/v1/repos/link')
    expect(steps).not.toContain('Manage repos')
    // And it is the same wording `adopt.ts` throws and `configure` prints, not a third copy.
    expect(steps).toContain(
      unreachableRepoSteps([], [{ owner: 'acme', name: 'cf-acc-catalog-api' }])[1],
    )
  })

  it('matches a repository name case-insensitively, as both providers do', async () => {
    await satisfied('target-repos', {
      client: client([repo('CF-Acc-Catalog-API'), repo('cf-acc-catalog-web')]),
    })
  })

  it('refuses a repository that already backs a service on a FRESH pass', async () => {
    const verdict = await refusal('target-repos', {
      client: client([
        repo('cf-acc-catalog-api', { serviceId: 'blk_9' }),
        repo('cf-acc-catalog-web'),
      ]),
    })
    expect(verdict.problem).toContain('blk_9')
    // Compared against the renderer rather than a spelling, so this stays an assertion about WHICH
    // command is offered; `operatorText.test.ts` pins what each shell's form must be.
    expect(commandsOf(verdict.remedy)[0]).toBe(resumeInvocation('latest'))
  })

  it('allows the link the LEDGER names, on a resumed pass', async () => {
    // The ledger's ids are what tell "mine, yesterday" from "someone else's".
    const detail = await satisfied('target-repos', {
      client: client([
        repo('cf-acc-catalog-api', { serviceId: 'blk_9' }),
        repo('cf-acc-catalog-web'),
      ]),
      adoptedServiceIds: ['blk_9'],
    })
    expect(detail).toContain('own ledger names')
  })

  it('still refuses a link the ledger does NOT name, mid-resume', async () => {
    // The case a boolean "is this a resume" flag answered wrongly: a ledger holding only the BACKEND
    // service made the flag true for the FRONTEND repository too, so a colleague's frontend service
    // was silently adopted and both passes then filed work under one frame.
    const verdict = await refusal('target-repos', {
      client: client([
        repo('cf-acc-catalog-api', { serviceId: 'blk_mine' }),
        repo('cf-acc-catalog-web', { serviceId: 'blk_theirs' }),
      ]),
      adoptedServiceIds: ['blk_mine'],
    })
    expect(verdict.problem).toContain('blk_theirs')
    expect(verdict.problem).not.toContain("'cf-acc-catalog-api' already backs")
    expect(verdict.problem).toContain('it names blk_mine')
  })

  it('refuses a repository whose service is homed on ANOTHER board, which serviceId cannot state', async () => {
    // `serviceId: null` with `linkedElsewhere: true` is the contract's honest answer for a service
    // this workspace-scoped key cannot address. Reading only the id passes the gate and leaves a
    // `repo_service_homed_elsewhere` 409 for spec 01's first adopt.
    const verdict = await refusal('target-repos', {
      client: client([
        repo('cf-acc-catalog-api', { linkedElsewhere: true }),
        repo('cf-acc-catalog-web'),
      ]),
    })
    expect(verdict.problem).toContain('ANOTHER board')
    expect(verdict.remedy.steps.join('\n')).toContain('repo_service_homed_elsewhere')
  })

  it('refuses a reachable-but-unadopted repository whose service is homed elsewhere', async () => {
    // The hole that opened when "unlinked" started meaning "spec 01 will link it": `linkedElsewhere`
    // is an ACCOUNT-scoped judgement, so it is true for a repository this board has not adopted, and
    // `POST /api/v1/services` refuses it either way. Judging only the LINKED rows green-lit exactly
    // this case, and the pass then died on the adopt, after the gate that exists to precede it.
    const verdict = await refusal('target-repos', {
      client: client(
        [repo('cf-acc-catalog-web')],
        [repo('cf-acc-catalog-api', { linkedElsewhere: true })],
      ),
    })
    expect(verdict.problem).toContain('ANOTHER board')
    expect(verdict.problem).toContain('cf-acc-catalog-api')
  })

  it('refuses a reachable-but-unadopted repository already backing a service on THIS board', async () => {
    const verdict = await refusal('target-repos', {
      client: client(
        [repo('cf-acc-catalog-web')],
        [repo('cf-acc-catalog-api', { serviceId: 'blk_9' })],
      ),
    })
    expect(verdict.problem).toContain('blk_9')
  })

  it('refuses a monorepo, which backs a service only with a subdirectory', async () => {
    const verdict = await refusal('target-repos', {
      client: client([repo('cf-acc-catalog-api', { monorepo: true }), repo('cf-acc-catalog-web')]),
    })
    expect(verdict.problem).toContain('MONOREPO')
  })

  it('says outright that EMPTINESS is not what it checked', async () => {
    // The one claim this probe deliberately does not make: no `/api/v1` read publishes whether a
    // repository holds content, and a verdict that read as "both are empty" would be a guess.
    const detail = await satisfied('target-repos', { client: client(both()) })
    expect(detail).toContain('not readable over /api/v1')
  })
})

describe('issue-credential', () => {
  const client = (provider: string | null) =>
    ({
      vcs: {
        getConnection: async () => ({
          connection: provider ? { provider, accountLogin: 'intended-org' } : null,
        }),
      },
    }) as unknown as CatFactoryClient

  it('sends an expired token to be re-minted, naming both scope shapes that work', async () => {
    const verdict = await refusal('issue-credential', {
      client: client('github'),
      issueApiFor: issueApiFor({ status: 'unauthenticated' }),
    })
    expect(verdict.problem).toContain('401')
    expect(verdict.remedy.steps.join('\n')).toContain('Issues: Read and write')
    // The prefilled minting page is the whole reason `configure` grew a step for this.
    expect(verdict.remedy.steps.join('\n')).toContain('run configure')
  })

  it('names BOTH causes of a 404, which a provider deliberately answers identically', async () => {
    const verdict = await refusal('issue-credential', {
      client: client('github'),
      issueApiFor: issueApiFor({ status: 'unreachable' }),
    })
    expect(verdict.problem).toContain('cf-acc-catalog-api')
    expect(verdict.remedy.steps.join('\n')).toContain('Grant this token access')
    // The repository the SPEC files against, not the other one: probing the wrong half would pass a
    // pass that then cannot file.
    expect(commandsOf(verdict.remedy).join('\n')).toContain(
      'https://api.github.com/repos/intended-org/cf-acc-catalog-api',
    )
  })

  it('offers the one-click fix for a repository with Issues switched off', async () => {
    const verdict = await refusal('issue-credential', {
      client: client('github'),
      issueApiFor: issueApiFor({ status: 'issues-disabled' }),
    })
    expect(verdict.remedy.steps.join('\n')).toContain('Turn Issues on')
  })

  it('states what would unblock a provider this suite cannot file on', async () => {
    // Not a defect to work around silently: the missing piece is one configured URL, and a refusal
    // that says so is what stops the next reader concluding the client is broken.
    const verdict = await refusal('issue-credential', {
      client: client('gitlab'),
      issueApiFor: () => null,
    })
    expect(verdict.problem).toContain('gitlab')
    expect(verdict.remedy.steps.join('\n')).toContain('ACCEPTANCE_VCS_API_BASE')
  })

  it('reports an unreadable probe as UNKNOWN rather than as a bad credential', async () => {
    const verdict = await unreadable('issue-credential', {
      client: client('github'),
      issueApiFor: issueApiFor({
        status: 'unreadable',
        detail: 'connect ECONNREFUSED 140.82.121.6:443',
      }),
    })
    expect(verdict.probeFailure).toContain('connect ECONNREFUSED')
    // The one override that turns this into a fix rather than a shrug.
    expect(verdict.remedy.steps.join('\n')).toContain('ACCEPTANCE_VCS_API_BASE')
  })

  it('leads with the probe’s own hint, which is the remedy for what actually happened', async () => {
    // The probe describes its provider-facing failure through kernel (it is the one check that
    // leaves the deployment, so the gate's probe context cannot), and its per-cause sentence is
    // strictly more than the candidates this remedy lists. Relayed, never paraphrased.
    const verdict = await unreadable('issue-credential', {
      client: client('github'),
      issueApiFor: issueApiFor({
        status: 'unreadable',
        detail: 'self-signed certificate',
        hint: 'The provider presented a TLS certificate this deployment does not trust.',
      }),
    })
    expect(verdict.remedy.steps[0]).toContain('TLS certificate')
  })

  it('does not claim a verdict when nothing is connected, since the provider decides the API', async () => {
    const verdict = await unreadable('issue-credential', { client: client(null) })
    expect(verdict.probeFailure).toContain('vcs-connection')
  })
})

describe('tracker-writeback', () => {
  const client = (writeback: Record<string, boolean>, updatedAt: number | null = null) =>
    ({
      tracker: { getWriteback: async () => ({ writeback, updatedAt }) },
    }) as unknown as CatFactoryClient

  const all = { commentOnPrOpen: true, resolveOnMerge: true, questionsOnPark: true }

  it('passes a workspace that has never configured it, since the defaults are ON', async () => {
    // The gate exists for the deliberately-off case; a fresh board must not have to configure
    // anything to run the pass.
    const detail = await satisfied('tracker-writeback', { client: client(all) })
    expect(detail).toContain('deployment defaults')
  })

  it('says whose choice it is reporting when the workspace HAS configured it', async () => {
    const detail = await satisfied('tracker-writeback', { client: client(all, 1_700_000_000_000) })
    expect(detail).toContain("workspace's own setting")
  })

  it('names every action that is off, and offers the merging PATCH as the fix', async () => {
    const verdict = await refusal('tracker-writeback', {
      client: client({ ...all, commentOnPrOpen: false, resolveOnMerge: false }, 1),
    })
    expect(verdict.problem).toContain('resolveOnMerge')
    expect(verdict.problem).toContain('commentOnPrOpen')
    const commands = commandsOf(verdict.remedy).join('\n')
    expect(commands).toContain('PATCH')
    expect(commands).toContain('/api/v1/tracker/writeback')
    // A MERGE, so the fix cannot quietly move the setting it does not name.
    expect(verdict.remedy.steps.join('\n')).toContain('MERGE')
  })

  it('passes with questionsOnPark off, which spec 04 does not use, and says so', async () => {
    const detail = await satisfied('tracker-writeback', {
      client: client({ ...all, questionsOnPark: false }, 1),
    })
    expect(detail).toContain('questionsOnPark is off')
  })
})

describe('board-titles', () => {
  it('offers the resume before the new prefix, since resuming is what keeps the two apart', async () => {
    const verdict = await refusal('board-titles', {
      client: {
        services: { list: async () => ({ services: [{ title: 'cf-acc Catalog API' }] }) },
      } as unknown as CatFactoryClient,
      serviceTitles: ['cf-acc Catalog API', 'cf-acc Catalog Web'],
    })
    const commands = commandsOf(verdict.remedy)
    expect(commands[0]).toContain('run status')
    expect(commands[1]).toBe(resumeInvocation('latest'))
    expect(commands[2]).toBe(perPersonPrefixInvocation('cf-acc'))
  })
})

describe('cluster-connection', () => {
  it('separates reachable, valid and permitted, which the probe answer cannot', async () => {
    const verdict = await refusal('cluster-connection', {
      client: {
        environments: {
          testConnection: async () => ({ ok: false, message: 'Unauthorized' }),
        },
      } as unknown as CatFactoryClient,
    })
    const commands = commandsOf(verdict.remedy).join('\n')
    expect(commands).toContain('kubectl cluster-info')
    expect(commands).toContain('kubectl auth can-i create namespaces')
    expect(commands).toContain('cat-factory-token')
    expect(verdict.remedy.docs).toBe('backend/docs/local-k3s-environments.md')
  })
})

describe('ingress-template', () => {
  it('hands back the default template, which is the whole fix', async () => {
    const verdict = await refusal('ingress-template', {
      config: config({
        cluster: { ...config().cluster, ingressHostTemplate: '{{branch}}.{{namespace}}.nip.io' },
      }),
    })
    expect(commandsOf(verdict.remedy)[0]).toContain("'{{namespace}}.127.0.0.1.nip.io'")
  })
})
