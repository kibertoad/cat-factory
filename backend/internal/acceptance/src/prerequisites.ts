// The prerequisite checks, in the order they are worth learning about.
//
// Ordering is deliberate: the deployment's own health first (a misconfigured backend explains
// every other failure), then the key, then the capabilities a run consumes in the order a run
// consumes them, then the cluster. An operator reading the output top to bottom reads it in
// causal order.
//
// **What belongs here.** A condition that (a) is knowable BEFORE anything is created and (b) ends
// or corrupts a pass when false. Everything on this list was previously discovered somewhere
// between fifteen and ninety minutes in. What does NOT belong: anything requiring a dispatch to
// find out (whether the model can actually scaffold a Fastify app is a model question this suite
// deliberately does not grade), and anything the suite can proceed through, which is what the
// `advisory` disposition is for.
//
// Each check answers with a REMEDY, and a probe that cannot read an answer says so as `unknown`
// rather than guessing a verdict. `preflight.ts` explains why that is three states and not two.

import type { CatFactoryClient } from '@cat-factory/sdk'
import type { AppApi } from './appApi.ts'
import type { AcceptanceConfig } from './config.ts'
import { buildK3sHandlerConfig, buildK3sSecrets, renderEnvironmentHost } from './k3s.ts'
import type { Prerequisite, PrerequisiteVerdict } from './preflight.ts'
import { describeKeyProblem } from './publicApi.ts'

export type PreflightContext = {
  config: AcceptanceConfig
  client: CatFactoryClient
  app: AppApi
  /** Board titles this pass will use. Supplied rather than derived: `fixtures.ts` owns them. */
  serviceTitles: readonly string[]
  /** True when the ledger already names bootstrapped services, i.e. this is a RESUMED pass. */
  hasBootstrappedServices: boolean
}

const satisfied = (detail: string): PrerequisiteVerdict => ({ status: 'satisfied', detail })
const unsatisfied = (problem: string, remedy: string): PrerequisiteVerdict => ({
  status: 'unsatisfied',
  problem,
  remedy,
})

export const PREREQUISITES: readonly Prerequisite<PreflightContext>[] = [
  {
    id: 'deployment-health',
    what: 'the backend booted with a valid configuration',
    disposition: 'required',
    check: async ({ app }) => {
      const health = await app.health()
      if (health.status === 'ok') return satisfied('the backend reports healthy')
      if (health.status !== 'misconfigured') {
        return unsatisfied(
          `GET /health answered '${health.status}' rather than 'ok'`,
          'Read the deployment log. Nothing downstream of a backend in this state is diagnosable.',
        )
      }
      // The fallback app publishes what it is missing, so report the deployment's OWN diagnosis
      // verbatim rather than a paraphrase of the 503 every other route would answer.
      const problems = await app.configProblems()
      const detail =
        problems.length === 0
          ? '(the deployment reported no problem list)'
          : problems
              .map((problem) => `${problem.key}: ${problem.summary} ${problem.remedy}`)
              .join('\n    ')
      return unsatisfied(
        `the backend is running its MISCONFIGURED fallback, which answers 503 on every route ` +
          `except /health and /auth/config. It reports:\n    ${detail}`,
        'Set the variables above and restart the deployment.',
      )
    },
  },
  {
    id: 'api-key',
    what: 'the public-API key names this workspace and carries the scope the suite needs',
    disposition: 'required',
    check: async ({ client, config }) => {
      const identity = await client.me.get()
      const problem = describeKeyProblem(identity, config.workspaceId)
      return problem
        ? unsatisfied(
            problem,
            'Mint an admin-scoped key on the workspace named by ACCEPTANCE_WORKSPACE_ID.',
          )
        : satisfied(
            `key ${identity.keyId} ('${identity.label}') is admin on ${identity.workspaceId}`,
          )
    },
  },
  {
    id: 'spend-budget',
    what: 'the workspace has budget left to run agents with',
    disposition: 'required',
    check: async ({ client }) => {
      const usage = await client.usage.get()
      const { costSpent, costLimit, exceeded } = usage.budget
      const spend = `${costSpent.toFixed(2)}/${costLimit.toFixed(2)} ${usage.currency}`
      return exceeded
        ? unsatisfied(
            `the workspace is over its budget for this period (${spend}), so runs are PAUSED ` +
              `until it rolls over. Every step this suite dispatches would refuse.`,
            'Raise the workspace budget, or wait for the period to roll over.',
          )
        : satisfied(`${spend} spent this period`)
    },
  },
  {
    id: 'agent-model',
    what: 'a model is wired that agent steps can actually dispatch to',
    disposition: 'required',
    check: async ({ app }) => {
      const models = await app.listModels()
      const available = models.filter((model) => model.available)
      if (available.length > 0) {
        const names = available
          .slice(0, 3)
          .map((model) => model.label)
          .join(', ')
        return satisfied(
          `${available.length} of ${models.length} selectable (${names}${available.length > 3 ? ', …' : ''})`,
        )
      }
      // Two causes with different fixes, and the catalog distinguishes them: a model blocked by
      // the account's model-family policy is CONFIGURED, so telling its operator to add a key
      // sends them to change a setting that is already correct.
      const blocked = models.filter((model) => model.policyBlocked)
      return blocked.length === models.length && models.length > 0
        ? unsatisfied(
            `all ${models.length} catalog models are blocked by the account's model-family policy`,
            "Permit a family on the account's model policy, or point the suite at a workspace whose policy does.",
          )
        : unsatisfied(
            `no model in the ${models.length}-entry catalog is selectable, so every agent step ` +
              `would fail at dispatch`,
            'Connect a provider API key or a subscription for at least one model.',
          )
    },
  },
  {
    id: 'vcs-connection',
    what: 'the workspace can create repositories under ACCEPTANCE_REPO_OWNER and push workflows',
    disposition: 'required',
    check: async ({ app, config }) => {
      const connection = await app.vcsConnection()
      if (!connection) {
        return unsatisfied(
          'the workspace has no VCS connection, so spec 01 has nothing to create repositories with',
          'Connect the workspace to its VCS provider (a GitHub App installation or a PAT).',
        )
      }
      // Collected rather than returned one at a time: three separate afternoons is the exact
      // failure the whole gate exists to prevent.
      const problems: string[] = []
      if (connection.accountLogin.toLowerCase() !== config.repoOwner.toLowerCase()) {
        problems.push(
          `it is connected to '${connection.accountLogin}' but ACCEPTANCE_REPO_OWNER is ` +
            `'${config.repoOwner}', so every bootstrap would target an account this workspace cannot reach`,
        )
      }
      if (!connection.canCreateRepos) {
        problems.push('it cannot create repositories, which is the first thing spec 01 asks of it')
      }
      if (!connection.canManageWorkflows) {
        // The bootstrapped repositories ship a build-and-push workflow, and spec 02 asserts a
        // real CI gate. Without `workflows: write` the provider REJECTS the push that adds it,
        // which surfaces as a bootstrap that half-worked.
        problems.push(
          'it was not granted permission to write workflow files, so the bootstrapped ' +
            "repositories' CI workflow cannot be pushed and spec 02's CI gate has nothing to gate on",
        )
      }
      return problems.length === 0
        ? satisfied(
            `${connection.provider ?? 'github'} connection to '${connection.accountLogin}' ` +
              `(${connection.method}) can create repositories and write workflows`,
          )
        : unsatisfied(
            `the ${connection.provider ?? 'github'} connection to '${connection.accountLogin}' is ` +
              `not sufficient:\n    ${problems.join('\n    ')}`,
            'Re-connect the workspace to the right account, granting repository creation and workflow write.',
          )
    },
  },
  {
    id: 'auto-merge-policy',
    what: 'the default merge preset permits the auto-merge every spec ends on',
    disposition: 'required',
    check: async ({ app }) => {
      const presets = await app.listRiskPolicies()
      const fallback = presets.find((preset) => preset.isDefault)
      if (!fallback) {
        return unsatisfied(
          `none of the ${presets.length} merge preset(s) in this workspace is marked default, so ` +
            `a task that pins none has no policy to resolve`,
          'Mark one preset as the workspace default.',
        )
      }
      if (!fallback.autoMergeEnabled) {
        return unsatisfied(
          `the default preset '${fallback.name}' has auto-merge disabled, so every run routes its ` +
            `pull request to a human and stops at 'blocked'. This suite asserts each run reached ` +
            `'done', which the platform reaches only on a real merge.`,
          `Pick a preset that permits auto-merge as the workspace default, or enable it on '${fallback.name}'.`,
        )
      }
      // Stated rather than graded: the suite cannot resolve which ROLE its key's runs are
      // admitted under from `/api/v1/me`, so claiming to have checked a role-scoped bar would be
      // a verdict this probe has not earned.
      const caveat =
        fallback.dryRunRoles.length > 0
          ? ` (note: it forces dry-run for role(s) ${fallback.dryRunRoles.join(', ')}; ` +
            `if this key's runs are admitted under one of those, nothing will merge)`
          : ''
      return satisfied(`default preset '${fallback.name}' permits auto-merge${caveat}`)
    },
  },
  {
    id: 'board-titles',
    what: 'this pass will not adopt or collide with another pass’s service frames',
    disposition: 'required',
    check: async ({ client, serviceTitles, hasBootstrappedServices }) => {
      const { services } = await client.services.list()
      const taken = serviceTitles.filter((title) =>
        services.some((service) => service.title === title),
      )
      if (taken.length === 0 || hasBootstrappedServices) {
        // On a RESUMED pass the frames existing is the point: the ledger names them and spec 01
        // re-reads the board to confirm they are still there.
        return satisfied(
          hasBootstrappedServices
            ? 'resuming a pass whose services the ledger already names'
            : `neither '${serviceTitles.join("' nor '")}' exists on this board yet`,
        )
      }
      return unsatisfied(
        `this board already has ${taken.map((title) => `'${title}'`).join(' and ')}, but this ` +
          `pass’s ledger names no services. A fresh pass would bootstrap a SECOND frame under ` +
          `the same title, and a later resume would have no way to tell the two apart.`,
        'Set ACCEPTANCE_NAME_PREFIX to something unused, resume the earlier pass with its ' +
          'ACCEPTANCE_RUN_ID, or delete the leftover frames.',
      )
    },
  },
  {
    id: 'cluster-connection',
    what: 'the k3s apiserver answers the supplied ServiceAccount token',
    disposition: 'required',
    check: async ({ app, config }) => {
      // The one probe that touches the cluster WITHOUT persisting anything. Its value is timing:
      // the same credential failure found by a `deployer` step arrives after a design pass and an
      // implementation have already been paid for.
      const result = await app.testEnvironmentHandler(
        buildK3sHandlerConfig(config.cluster),
        buildK3sSecrets(config.cluster),
      )
      const tls = config.cluster.caCertPem
        ? 'custom CA'
        : `insecureSkipTlsVerify=${config.cluster.insecureSkipTlsVerify}`
      return result.ok
        ? satisfied(`${config.cluster.apiServerUrl} answered (${tls})`)
        : unsatisfied(
            `the connection probe to ${config.cluster.apiServerUrl} (${tls}) failed: ` +
              `${result.message ?? '(no message)'}`,
            'Grant the ServiceAccount the RBAC in backend/docs/local-k3s-environments.md, ' +
              'including the cluster-wide binding that lets it create per-PR namespaces.',
          )
    },
  },
  {
    id: 'ingress-template',
    what: 'an environment URL can be derived from the configured host template',
    disposition: 'required',
    check: async ({ config }) => {
      // Rendered against a sample namespace: the real one carries a pull-request number no run
      // has produced yet. What it proves is that the template holds no hole the platform cannot
      // fill, the failure that otherwise appears as an environment stuck `provisioning` behind a
      // URL nobody can resolve.
      const host = renderEnvironmentHost(config.cluster.ingressHostTemplate, 'cf-acc-1')
      return host === null
        ? unsatisfied(
            `ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE ('${config.cluster.ingressHostTemplate}') still ` +
              `holds an unrendered placeholder after {{namespace}} is substituted`,
            'Build the template from {{namespace}} only: it is the one value known before a run opens its pull request.',
          )
        : satisfied(`renders as '${host}'`)
    },
  },
  {
    id: 'pipeline-catalog',
    what: 'the board has already adopted the two pipelines this suite drives',
    disposition: 'advisory',
    check: async ({ client }) => {
      const { pipelines } = await client.pipelines.list()
      const ids = pipelines.map((pipeline) => pipeline.pipelineId)
      const missing = ['pl_build', 'pl_bugfix'].filter((wanted) => !ids.includes(wanted))
      // Advisory for a real reason rather than a soft one: a board predating a catalog pipeline
      // holds no row for it and MATERIALISES one on first start, so an absent id is a heads-up
      // and not a failure.
      return missing.length === 0
        ? satisfied('pl_build and pl_bugfix are both adopted')
        : unsatisfied(
            `${missing.join(' and ')} not yet adopted by this board (has: ${ids.join(', ') || 'none'}); ` +
              `a run naming one adopts it on first start`,
            'Nothing to do. Stated because a pipeline that then fails to adopt looks like a broken start.',
          )
    },
  },
]
