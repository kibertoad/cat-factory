import type { CatFactoryClient } from '@cat-factory/sdk'
import { describe, expect, it } from 'vitest'
import type { AcceptanceConfig } from '../src/config.ts'
import type { PrerequisiteVerdict, Remedy } from '../src/preflight.ts'
import { type PreflightContext, PREREQUISITES } from '../src/prerequisites.ts'

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
    cluster: {
      apiServerUrl: 'https://127.0.0.1:6443',
      apiToken: 'sa-token',
      caCertPem: null,
      insecureSkipTlsVerify: true,
      ingressHostTemplate: '{{namespace}}.127.0.0.1.nip.io',
      namespaceTemplate: 'cf-acc-{{pullNumber}}',
    },
    stateDir: '.acceptance',
    runBudgetMs: 60_000,
    ...overrides,
  }
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
    hasBootstrappedServices: false,
    ...context,
  } as PreflightContext)
  if (verdict.status !== 'unsatisfied') {
    throw new Error(`expected '${id}' to refuse, got '${verdict.status}'`)
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
  const app = (status: string, problems: unknown[] = []) =>
    ({
      health: async () => ({ status }),
      configProblems: async () => problems,
    }) as unknown as PreflightContext['app']

  it("relays the deployment's own per-variable remedy and doc link rather than paraphrasing", async () => {
    // The backend already writes the better message: it names the variable, what breaks without
    // it, and the exact command that produces a value. A paraphrase here would be a second copy
    // of it, one release behind.
    const verdict = await refusal('deployment-health', {
      app: app('misconfigured', [
        {
          key: 'ENCRYPTION_KEY',
          summary: 'Seals every per-workspace credential at rest.',
          remedy: 'Generate one with `openssl rand -base64 32`.',
          docsUrl: 'https://www.catfactory.ai/env',
        },
      ]),
    })
    expect(verdict.remedy.steps[0]).toContain('openssl rand -base64 32')
    expect(verdict.remedy.steps[0]).toContain('https://www.catfactory.ai/env')
    expect(verdict.remedy.steps.at(-1)).toContain('RESTART')
  })

  it('says so when a misconfigured deployment publishes no problem list', async () => {
    // "Absent" and "nothing wrong" must not render the same: an empty list here means the
    // diagnosis has to come from the boot log, and the remedy is the only place that is said.
    const verdict = await refusal('deployment-health', { app: app('misconfigured') })
    expect(verdict.remedy.steps[0]).toContain('boot log')
  })

  it('names the SPA-vs-backend mixup for a health verdict that is neither ok nor misconfigured', async () => {
    const verdict = await refusal('deployment-health', { app: app('degraded') })
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
    expect(commandsOf(verdict.remedy)).toContain('export ACCEPTANCE_WORKSPACE_ID=ws_other')
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

describe('vcs-connection', () => {
  const app = (connection: Record<string, unknown> | null) =>
    ({ vcsConnection: async () => connection }) as unknown as PreflightContext['app']

  const connected = (overrides: Record<string, unknown> = {}) => ({
    accountLogin: 'intended-org',
    provider: 'github',
    method: 'app',
    canCreateRepos: true,
    canManageWorkflows: true,
    ...overrides,
  })

  it('offers the connected account as the other way to resolve an owner mismatch', async () => {
    const verdict = await refusal('vcs-connection', {
      app: app(connected({ accountLogin: 'someone-else' })),
    })
    expect(commandsOf(verdict.remedy)).toContain('export ACCEPTANCE_REPO_OWNER=someone-else')
  })

  it('gives each insufficiency its own step, so one reconnect fixes both', async () => {
    // Three afternoons, one per problem, is the exact failure the whole gate exists to prevent,
    // and instructions that name only the first problem reintroduce it.
    const verdict = await refusal('vcs-connection', {
      app: app(connected({ canCreateRepos: false, canManageWorkflows: false })),
    })
    const steps = verdict.remedy.steps.join('\n')
    expect(steps).toContain('repository creation')
    expect(steps).toContain('Workflows: read and write')
  })

  it('names the workflow permission when nothing is connected at all', async () => {
    const verdict = await refusal('vcs-connection', { app: app(null) })
    expect(verdict.remedy.steps.join('\n')).toContain('workflow')
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
    expect(commands[1]).toContain('ACCEPTANCE_RUN_ID=latest')
    expect(commands[2]).toContain('ACCEPTANCE_NAME_PREFIX="cf-acc-$(whoami)"')
  })
})

describe('cluster-connection', () => {
  it('separates reachable, valid and permitted, which the probe answer cannot', async () => {
    const verdict = await refusal('cluster-connection', {
      app: {
        testEnvironmentHandler: async () => ({ ok: false, message: 'Unauthorized' }),
      } as unknown as PreflightContext['app'],
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
