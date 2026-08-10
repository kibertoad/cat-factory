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
//
// **A remedy here is INSTRUCTIONS, and it is built from what the probe just read.** Every command
// below is rendered with this deployment's base URL, this workspace's id, this pass's run id and
// the value that actually failed, because the point is that the refusal can be acted on without a
// second search. Two rules keep that honest, and both are load-bearing:
//
//   - **Never invent a CLI.** Minting an API token, raising a budget, wiring a provider and
//     re-connecting a VCS account are console actions with no command behind them. Those remedies
//     name the SCREEN, and carry a read-only command that CONFIRMS the change landed, which is
//     the half a terminal can genuinely do.
//   - **Relay the platform's own diagnosis rather than paraphrasing it.** A misconfigured backend
//     publishes a per-variable remedy (often with the exact `openssl`/`npx` line) and a doc link;
//     `deployment-health` passes those through verbatim. A paraphrase here would be a second,
//     staler copy of a message the deployment already writes better.

import type {
  CatFactoryClient,
  ListPublicModelPresetsResponsePreset,
  ListPublicWiredModelsResponseModel,
} from '@cat-factory/sdk'
import { findRepo } from './adopt.ts'
import type { DeploymentApi } from './deploymentApi.ts'
import type { AcceptanceConfig } from './config.ts'
import { buildK3sConnection, buildK3sSecrets, renderEnvironmentHost } from './k3s.ts'
import type { Prerequisite, PrerequisiteVerdict, Remedy, RemedyCommand } from './preflight.ts'
import { describeKeyProblem, type KeyProblem, type PublicIdentity } from './publicApi.ts'

export type PreflightContext = {
  config: AcceptanceConfig
  client: CatFactoryClient
  deployment: DeploymentApi
  /** Board titles this pass will use. Supplied rather than derived: `fixtures.ts` owns them. */
  serviceTitles: readonly string[]
  /** True when the ledger already names adopted services, i.e. this is a RESUMED pass. */
  hasAdoptedServices: boolean
}

const satisfied = (detail: string): PrerequisiteVerdict => ({ status: 'satisfied', detail })
const unsatisfied = (problem: string, remedy: Remedy): PrerequisiteVerdict => ({
  status: 'unsatisfied',
  problem,
  remedy,
})

const K3S_DOC = 'backend/docs/local-k3s-environments.md'

/**
 * A read-only `curl` through `/api/v1`, which is key-authed: reads `CAT_FACTORY_API_KEY` from the
 * shell.
 *
 * Every remedy whose fix is a SCREEN still owes the operator a way to see the new answer without
 * re-running an afternoon-long suite to find out, and this is that way. One helper rather than two
 * because every prerequisite this suite checks is now readable with the same credential the suite
 * itself holds.
 */
function publicApiRead(config: AcceptanceConfig, path: string, purpose: string): RemedyCommand {
  return {
    run: `curl -sS -H "Authorization: Bearer $CAT_FACTORY_API_KEY" '${config.baseUrl}/api/v1${path}'`,
    purpose,
  }
}

/** Every preset the deployment offers, as `id (name → model)`, for a refusal that names the choice. */
function describePresets(presets: readonly ListPublicModelPresetsResponsePreset[]): string {
  const listed = presets.map(
    (preset) => `${preset.presetId} ('${preset.name}' → ${preset.baseModelId})`,
  )
  return listed.join(', ') || '(none: this workspace holds no preset library)'
}

/**
 * The presets whose base model IS selectable right now.
 *
 * Joined against the catalog rather than listing every preset, because a refusal that offers an
 * alternative the deployment cannot dispatch to either has sent the reader round the same loop.
 */
function describeAvailablePresets(
  presets: readonly ListPublicModelPresetsResponsePreset[],
  models: readonly ListPublicWiredModelsResponseModel[],
): string {
  const selectable = new Set(
    models.filter((model) => model.available).map((model) => model.modelId),
  )
  const usable = presets.filter((preset) => selectable.has(preset.baseModelId))
  return usable.map((preset) => `${preset.presetId} ('${preset.name}')`).join(', ') || '(none)'
}

/**
 * The two ways an unusable key is unusable, and the fix for each.
 *
 * A `Record` over the closed `KeyProblem['code']` rather than a `switch`: adding a third failure
 * to `describeKeyProblem` then fails to compile here instead of quietly falling through to a
 * remedy written for a different problem.
 */
const KEY_REMEDIES: Record<
  KeyProblem['code'],
  (identity: PublicIdentity, config: AcceptanceConfig) => Remedy
> = {
  'workspace-mismatch': (identity, config) => ({
    steps: [
      `The key names workspace ${identity.workspaceId}; ACCEPTANCE_WORKSPACE_ID names ` +
        `${config.workspaceId}. Decide which board this pass belongs to, then move the other one.`,
      'To keep the key, point the suite at the board the key already names (the export below).',
      'To keep the board, mint a token on it: in the SPA, Integrations, "API access tokens", ' +
        'Create a token with scope "Full access", then export it as CAT_FACTORY_API_KEY. The ' +
        'secret is shown once and cannot be recovered.',
    ],
    commands: [
      {
        run: `export ACCEPTANCE_WORKSPACE_ID=${identity.workspaceId}`,
        purpose: 'point the suite at the board this key is already bound to',
      },
      publicApiRead(config, '/me', 'confirm which workspace and scope the key now names'),
    ],
  }),
  'insufficient-scope': (identity, config) => ({
    steps: [
      `A token's scope is fixed when it is created, so the '${identity.scope}' one cannot be ` +
        'raised: mint a new token rather than editing this one.',
      'In the SPA: Integrations, "API access tokens", Create a token, scope "Full access".',
      '"Full access" is the rung that carries both what spec 01 needs (creating services) and ' +
        'what spec 03 needs (answering a parked human gate).',
      'Export the new secret as CAT_FACTORY_API_KEY, then revoke the old token.',
    ],
    commands: [publicApiRead(config, '/me', 'confirm the new key is admin on this workspace')],
  }),
}

export const PREREQUISITES: readonly Prerequisite<PreflightContext>[] = [
  {
    id: 'deployment-health',
    what: 'the backend booted with a valid configuration',
    disposition: 'required',
    check: async ({ deployment, config }) => {
      const health = await deployment.health()
      if (health.status === 'ok') return satisfied('the backend reports healthy')
      if (health.status !== 'misconfigured') {
        return unsatisfied(`GET /health answered '${health.status}' rather than 'ok'`, {
          steps: [
            'Read the deployment log. Nothing downstream of a backend in this state is diagnosable.',
            `Check that CAT_FACTORY_BASE_URL (${config.baseUrl}) names the BACKEND rather than ` +
              'the SPA: the SPA serves a /health of its own, and a base URL pointing at it ' +
              'produces exactly this verdict against a backend that is perfectly healthy.',
          ],
          commands: [
            {
              run: `curl -sS '${config.baseUrl}/health'`,
              purpose: "re-read the deployment's own verdict once it has restarted",
            },
          ],
        })
      }
      // The fallback app publishes what it is missing, so report the deployment's OWN diagnosis
      // verbatim rather than a paraphrase of the 503 every other route would answer. Its remedies
      // already carry the exact command per variable (`openssl rand`, `npx @cat-factory/cli env`,
      // `docker compose up`) and often a doc link, which is why this branch relays and adds
      // nothing of its own beyond the restart and the way to re-read the list.
      const problems = await deployment.configProblems()
      const steps =
        problems.length === 0
          ? [
              'The deployment reported no problem list, which is unusual: read its boot log, where ' +
                'the same validation failure is printed in full.',
            ]
          : problems.map(
              (problem) =>
                `${problem.key}: ${problem.summary} Fix: ${problem.remedy}` +
                (problem.docsUrl ? ` Docs: ${problem.docsUrl}` : ''),
            )
      return unsatisfied(
        `the backend is running its MISCONFIGURED fallback, which answers 503 on every route ` +
          `except /health and /auth/config, over ${problems.length} problem(s) it names below`,
        {
          steps: [
            ...steps,
            "Set those in the deployment's own .env (local mode: `local/.env`), then RESTART it: " +
              'configuration is validated at boot and nothing re-reads the file.',
          ],
          commands: [
            {
              run: `curl -sS '${config.baseUrl}/auth/config'`,
              purpose:
                'read the same problem list back after the restart; an empty one means fixed',
            },
          ],
        },
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
        ? unsatisfied(problem.problem, KEY_REMEDIES[problem.code](identity, config))
        : satisfied(
            `key ${identity.keyId} ('${identity.label}') is admin on ${identity.workspaceId}`,
          )
    },
  },
  {
    id: 'spend-budget',
    what: 'the workspace has budget left to run agents with',
    disposition: 'required',
    check: async ({ client, config }) => {
      const usage = await client.usage.get()
      const { costSpent, costLimit, exceeded } = usage.budget
      const spend = `${costSpent.toFixed(2)}/${costLimit.toFixed(2)} ${usage.currency}`
      return exceeded
        ? unsatisfied(
            `the workspace is over its budget for this period (${spend}), so runs are PAUSED ` +
              `until it rolls over. Every step this suite dispatches would refuse.`,
            {
              steps: [
                'In the SPA: Workspace settings, "Budget", raise the monthly spend limit above ' +
                  `${costSpent.toFixed(2)} ${usage.currency} and save.`,
                'Or wait for the period to roll over, which resets the spent side rather than the limit.',
                'A pass costs real model spend on top of what is already recorded, so leave ' +
                  'headroom rather than raising the limit to exactly the current spend.',
              ],
              commands: [
                publicApiRead(
                  config,
                  '/usage',
                  'confirm the new limit and that `exceeded` is false',
                ),
              ],
            },
          )
        : satisfied(`${spend} spent this period`)
    },
  },
  {
    id: 'agent-model',
    what: 'a model is wired that agent steps can actually dispatch to',
    disposition: 'required',
    check: async ({ client, config }) => {
      const { models, excludesUserScopedModels } = await client.models.list()
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
      const catalogRead = publicApiRead(
        config,
        '/models',
        "list the catalog with each entry's `available` and `policyBlocked` flags",
      )
      return blocked.length === models.length && models.length > 0
        ? unsatisfied(
            `all ${models.length} catalog models are blocked by the account's model-family policy`,
            {
              steps: [
                'Every entry is CONFIGURED and refused, so adding another provider key changes nothing.',
                "Permit a family on the account's model policy (account settings), or point the " +
                  'suite at a workspace whose policy already does.',
              ],
              commands: [catalogRead],
            },
          )
        : unsatisfied(
            `no model in the ${models.length}-entry catalog is selectable, so every agent step ` +
              `would fail at dispatch`,
            {
              steps: [
                'In the SPA: Model providers, and add a provider API key or connect a subscription ' +
                  'for at least one model.',
                'An entry becomes selectable as soon as its provider is wired, with no restart.',
                // The THIRD cause, and the only one this read cannot see for itself: a deployment
                // whose models are one developer's local endpoints answers exactly like a
                // deployment with nothing wired, because a key has no developer to attribute them
                // to. Naming it here keeps the remedy from being "add a key" when a key is not
                // what is missing.
                ...(excludesUserScopedModels
                  ? [
                      'This deployment also serves per-user locally-run endpoints, which an API ' +
                        'key cannot see or dispatch to. If those are the only models wired, the ' +
                        'suite needs a provider key or a subscription of its own rather than one ' +
                        'more local endpoint.',
                    ]
                  : []),
              ],
              commands: [catalogRead],
              docs: 'backend/docs/model-support.md',
            },
          )
    },
  },
  {
    id: 'model-preset',
    what: 'ACCEPTANCE_MODEL_PRESET names a preset on this deployment whose model can be dispatched to',
    disposition: 'required',
    check: async ({ client, config }) => {
      // The check that would have turned the first live setup attempt's empty-model-catalog finding
      // into a PRESET problem instead of a mystery at the first dispatch. `agent-model` above says
      // whether ANY model is selectable; this one says whether the model THIS PASS pins is, which
      // are different questions the moment a pass names a preset.
      const presetRead = publicApiRead(
        config,
        '/model-presets',
        'list the preset library, with each row’s presetId, baseModelId and isDefault',
      )
      const { presets } = await client.modelPresets.list()
      const preset = presets.find((entry) => entry.presetId === config.modelPresetId)
      if (!preset) {
        return unsatisfied(
          `no preset in this workspace has id '${config.modelPresetId}', so every task this pass ` +
            `files would be refused at creation`,
          {
            steps: [
              `This deployment's presets are: ${describePresets(presets)}.`,
              'Set ACCEPTANCE_MODEL_PRESET to one of those ids, or unset it to take the built-in ' +
                "Claude preset ('mdp_claude').",
              '`pnpm --filter @cat-factory/acceptance run configure` offers the library as a menu, ' +
                'so the id never has to be typed.',
            ],
            commands: [presetRead],
          },
        )
      }

      const { models } = await client.models.list()
      const base = models.find((model) => model.modelId === preset.baseModelId)
      // Three states, not two: a preset whose base model the catalog does not name at all is a
      // different fault from one the deployment refuses, and both differ from a preset that is
      // fine. Rolling them together would send an operator to add a provider key for a model id
      // that no longer exists.
      if (!base) {
        return unsatisfied(
          `preset '${preset.name}' runs on model '${preset.baseModelId}', which this deployment's ` +
            `catalog does not list, so every agent step would fail at dispatch`,
          {
            steps: [
              'The preset outlived the model it names. Edit it in the SPA (Workspace settings, ' +
                '"Model presets") to a model the catalog carries, or point the suite at another preset.',
              `The catalog holds: ${models.map((model) => model.modelId).join(', ') || '(nothing)'}.`,
            ],
            commands: [presetRead, publicApiRead(config, '/models', 'list the catalog')],
          },
        )
      }
      if (!base.available) {
        return unsatisfied(
          `preset '${preset.name}' runs on '${base.label}' (${base.modelId}), which is in the ` +
            `catalog but not selectable${base.policyBlocked ? ' (refused by the account model-family policy)' : ' (no provider wired for it)'}`,
          {
            steps: base.policyBlocked
              ? [
                  'The model is CONFIGURED and refused, so adding a provider key changes nothing: ' +
                    "permit its family on the account's model policy, or pin a preset whose model " +
                    'the policy already permits.',
                ]
              : [
                  `In the SPA: Model providers, and wire a provider for '${base.modelId}' (a ` +
                    'provider API key, or a connected subscription).',
                  'Or pin a preset whose base model is already selectable: ' +
                    `${describeAvailablePresets(presets, models)}.`,
                ],
            commands: [publicApiRead(config, '/models', "read each entry's available flag back")],
            docs: 'backend/docs/model-support.md',
          },
        )
      }
      const overrides = Object.keys(preset.overrides).length
      // Overrides are COUNTED, not graded. Each names a per-kind model whose availability the same
      // join would answer, but a preset overriding one agent kind is a normal, deliberate
      // configuration and refusing a pass over it would grade the workspace's taste rather than
      // its wiring. The count is stated so a surprising dispatch model is not a surprise.
      return satisfied(
        `'${preset.name}' (${preset.presetId}) runs on ${base.label}` +
          (overrides > 0 ? `, with ${overrides} per-kind override(s)` : '') +
          (preset.isDefault ? ', and is this workspace’s default' : ''),
      )
    },
  },
  {
    id: 'vcs-connection',
    what: 'the workspace is connected to ACCEPTANCE_REPO_OWNER and may write workflow files',
    disposition: 'required',
    check: async ({ client, config }) => {
      const connectionRead = publicApiRead(
        config,
        '/vcs/connection',
        'read back what the workspace has connected, and with which permissions',
      )
      const { connection } = await client.vcs.getConnection()
      if (!connection) {
        return unsatisfied(
          'the workspace has no VCS connection, so it can neither see the two repositories this ' +
            'pass adopts nor push to them',
          {
            steps: [
              'In the SPA: Integrations, and connect the workspace to its VCS provider.',
              `A GitHub App installation must be granted access to both repositories under ` +
                `'${config.repoOwner}', plus "Workflows: read and write".`,
              'A personal access token must carry `repo` and `workflow` (GitHub classic) or `api` ' +
                '(GitLab). The scaffolded repositories push a CI workflow, which the provider ' +
                'rejects outright without the workflow permission.',
            ],
            commands: [connectionRead],
          },
        )
      }
      // Collected rather than returned one at a time: three separate afternoons is the exact
      // failure the whole gate exists to prevent. Each problem contributes its own step, so the
      // instructions stay in step with the diagnosis rather than restating a generic reconnect.
      //
      // `canCreateRepos` is deliberately NOT among them any more. The operator creates the two
      // repositories and `target-repos` below checks they arrived, so a connection that cannot
      // create one is now perfectly sufficient: that permission was the prerequisite no
      // configuration could satisfy on a PAT deployment, which is the whole reason for the change.
      const problems: string[] = []
      const steps: string[] = []
      const commands: RemedyCommand[] = []
      if (connection.accountLogin.toLowerCase() !== config.repoOwner.toLowerCase()) {
        problems.push(
          `it is connected to '${connection.accountLogin}' but ACCEPTANCE_REPO_OWNER is ` +
            `'${config.repoOwner}', so the repositories this pass adopts live under an account ` +
            `this workspace cannot reach`,
        )
        steps.push(
          `Either point the suite at the connected account (the export below), or re-connect the ` +
            `workspace to '${config.repoOwner}' under Integrations.`,
        )
        commands.push({
          run: `export ACCEPTANCE_REPO_OWNER=${connection.accountLogin}`,
          purpose: 'adopt the repositories under the account already connected',
        })
      }
      if (!connection.canManageWorkflows) {
        // The scaffold runs ship a build-and-push workflow, and spec 02 asserts a real CI gate.
        // Without `workflows: write` the provider REJECTS the push that adds it, which surfaces as
        // a scaffold pull request that half-worked.
        problems.push(
          'it was not granted permission to write workflow files, so the scaffolded CI workflow ' +
            "cannot be pushed and spec 02's CI gate has nothing to gate on",
        )
        steps.push(
          'Grant workflow writes: "Workflows: read and write" on a GitHub App installation, or ' +
            'the `workflow` scope on a GitHub classic PAT. A PAT scope cannot be widened in ' +
            'place, so re-mint it and paste the new token under Integrations.',
        )
      }
      if (problems.length === 0) {
        return satisfied(
          `${connection.provider} connection to '${connection.accountLogin}' ` +
            `(${connection.method}) may write workflow files`,
        )
      }
      commands.push(connectionRead)
      return unsatisfied(
        `the ${connection.provider} connection to '${connection.accountLogin}' is ` +
          `not sufficient:\n    ${problems.join('\n    ')}`,
        { steps, commands },
      )
    },
  },
  {
    id: 'target-repos',
    what: 'both repositories this pass adopts exist and are reachable, and neither is already in use',
    disposition: 'required',
    check: async ({ client, config, hasAdoptedServices }) => {
      const repoRead = publicApiRead(
        config,
        '/repos',
        'list the repositories this workspace can back a service with, and what already backs each',
      )
      const { repos } = await client.repos.list()
      const wanted = [
        { role: 'backend', name: config.repos.backend },
        { role: 'frontend', name: config.repos.frontend },
      ]
      const found = wanted.map((entry) => ({
        ...entry,
        repo: findRepo(repos, config.repoOwner, entry.name),
      }))

      const missing = found.filter((entry) => !entry.repo)
      if (missing.length > 0) {
        const visible = repos.map((repo) => `${repo.owner}/${repo.name}`)
        return unsatisfied(
          `${missing.map((entry) => `'${config.repoOwner}/${entry.name}'`).join(' and ')} ` +
            `${missing.length === 1 ? 'is' : 'are'} not listed by GET /api/v1/repos, so there is ` +
            `nothing for spec 01 to adopt`,
          {
            steps: [
              'Create each missing repository yourself, EMPTY except for a README: the scaffold ' +
                'runs open a pull request, which needs a default branch to target, and a ' +
                'repository with no commits has none.',
              'Then make sure this workspace reaches it: a GitHub App installation must include ' +
                'that repository, and a PAT must carry `repo`. A repository that exists and is ' +
                'invisible here answers identically to one that was never created.',
              `Visible to this workspace right now: ${visible.join(', ') || '(none)'}.`,
              'The `configure` command below opens a prefilled creation page per repository and ' +
                're-reads this list, so the next click is the thing the suite needs.',
            ],
            commands: [
              {
                run: 'pnpm --filter @cat-factory/acceptance run configure',
                purpose: 'open the creation page for each missing repository, then re-check',
              },
              repoRead,
            ],
          },
        )
      }

      // A repository already backing a service is the REPO half of what `board-titles` catches for
      // frames, and it needs the same split: on a resumed pass the link is this pass's own and is
      // the point, and on a fresh one it means the frame would be a second one over someone's
      // repository. Withheld from a resume rather than graded, because the ledger is what tells
      // "mine, yesterday" from "someone else's".
      const taken = found.filter((entry) => entry.repo?.serviceId)
      if (taken.length > 0 && !hasAdoptedServices) {
        return unsatisfied(
          `${taken.map((entry) => `'${entry.name}' already backs service ${entry.repo?.serviceId}`).join(', ')}` +
            `, but this pass's ledger names no services. A fresh pass would adopt a repository ` +
            `whose work belongs to another pass, and its scaffold run would open a pull request ` +
            `against a tree that is already built.`,
          {
            steps: [
              'If that service is from an earlier pass of yours, RESUME it rather than starting ' +
                'over: the ledger it left behind is what makes the two tellable apart.',
              'Otherwise point ACCEPTANCE_BACKEND_REPO / ACCEPTANCE_FRONTEND_REPO at two fresh ' +
                'empty repositories, or delete the service frame that holds this one.',
            ],
            commands: [
              {
                run: 'ACCEPTANCE_RUN_ID=latest pnpm --filter @cat-factory/acceptance run acceptance',
                purpose: 'resume the most recent pass instead of starting a second one',
              },
              repoRead,
            ],
          },
        )
      }

      // Past the `missing` guard every entry has a repository, but narrowed through a predicate
      // rather than asserted with `!`: the alternative renders `undefined/undefined` into the very
      // verdict a reader would rely on if this ever stopped being true.
      const resolved = found.flatMap((entry) => (entry.repo ? [entry.repo] : []))
      const monorepo = resolved.filter((repo) => repo.monorepo)
      if (monorepo.length > 0) {
        return unsatisfied(
          `${monorepo.map((repo) => `'${repo.name}'`).join(' and ')} ` +
            `${monorepo.length === 1 ? 'is' : 'are'} registered as a MONOREPO, which backs a ` +
            `service only with a subdirectory this suite does not configure`,
          {
            steps: [
              'Point the suite at two whole-repository targets. The two services here are two ' +
                'deployable applications with their own Dockerfiles, images and per-PR manifests, ' +
                'so a shared repository is a different scenario rather than a smaller one.',
            ],
            commands: [repoRead],
          },
        )
      }

      // Emptiness is STATED, never graded, and this is the one thing this check deliberately does
      // not claim. No `/api/v1` read publishes whether a repository holds content: the bootstrapper
      // used to answer it inside its container pre-flight, and putting it on the repository LIST
      // would mean one provider round-trip per row on every call. What a non-empty target actually
      // costs is a scaffold run that builds on top of whatever is there, which is a strange result
      // rather than a failure, so the honest disposition is to say the probe cannot see it.
      const names = resolved.map((repo) => `${repo.owner}/${repo.name}`).join(' and ')
      return satisfied(
        `${names} are reachable and ` +
          (taken.length > 0 ? `back this resumed pass's own service(s)` : 'back no service yet') +
          ` (whether they are EMPTY is not readable over /api/v1; a repository with content is ` +
          `scaffolded on top of)`,
      )
    },
  },
  {
    id: 'auto-merge-policy',
    what: 'the default risk policy permits the auto-merge every spec ends on',
    disposition: 'required',
    check: async ({ client, config }) => {
      const { policies } = await client.riskPolicies.list()
      const policyRead = publicApiRead(
        config,
        '/risk-policies',
        'read the policy library back, with `isDefault` and `autoMergeEnabled` on each row',
      )
      const fallback = policies.find((policy) => policy.isDefault)
      if (!fallback) {
        return unsatisfied(
          `none of the ${policies.length} risk polic(ies) in this workspace is marked default, so ` +
            `a task that pins none has no policy to resolve`,
          {
            steps: [
              'In the SPA: Workspace settings, "Risk policies", and mark one policy as the ' +
                'workspace default.',
              'This suite creates its tasks through /api/v1, which pins no policy, so the default ' +
                'is the only one its runs can resolve.',
            ],
            commands: [policyRead],
          },
        )
      }
      if (!fallback.autoMergeEnabled) {
        return unsatisfied(
          `the default policy '${fallback.name}' has auto-merge disabled, so every run routes its ` +
            `pull request to a human and stops at 'blocked'. This suite asserts each run reached ` +
            `'done', which the platform reaches only on a real merge.`,
          {
            steps: [
              `In the SPA: Workspace settings, "Risk policies", and either enable auto-merge on ` +
                `'${fallback.name}' or mark a policy that already permits it as the default.`,
              'A policy that holds every merge for a person is correctly configured for ordinary ' +
                'work and will stop this suite, so prefer a separate policy over loosening the ' +
                'one your real boards run on.',
            ],
            commands: [policyRead],
          },
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
      return satisfied(`default policy '${fallback.name}' permits auto-merge${caveat}`)
    },
  },
  {
    id: 'board-titles',
    what: 'this pass will not adopt or collide with another pass’s service frames',
    disposition: 'required',
    check: async ({ client, config, serviceTitles, hasAdoptedServices }) => {
      const { services } = await client.services.list()
      const taken = serviceTitles.filter((title) =>
        services.some((service) => service.title === title),
      )
      if (taken.length === 0 || hasAdoptedServices) {
        // On a RESUMED pass the frames existing is the point: the ledger names them and spec 01
        // re-reads the board to confirm they are still there.
        return satisfied(
          hasAdoptedServices
            ? 'resuming a pass whose services the ledger already names'
            : `neither '${serviceTitles.join("' nor '")}' exists on this board yet`,
        )
      }
      return unsatisfied(
        `this board already has ${taken.map((title) => `'${title}'`).join(' and ')}, but this ` +
          `pass’s ledger names no services. A fresh pass would raise a SECOND frame under the ` +
          `same title, and a later resume would have no way to tell the two apart.`,
        {
          steps: [
            'If those frames belong to an earlier pass of yours, RESUME it rather than starting ' +
              'over: the ledger it left behind is what makes the two tellable apart.',
            `If they belong to someone else, take a prefix of your own (today's is ` +
              `'${config.namePrefix}'), which renames every service frame and task this pass ` +
              'creates. The repository names are ACCEPTANCE_BACKEND_REPO / ' +
              'ACCEPTANCE_FRONTEND_REPO and move separately.',
            'Otherwise delete the leftover frames from the board and re-run.',
          ],
          commands: [
            {
              run: 'pnpm --filter @cat-factory/acceptance run status',
              purpose: 'show the most recent pass and its run id, without touching the deployment',
            },
            {
              run: 'ACCEPTANCE_RUN_ID=latest pnpm --filter @cat-factory/acceptance run acceptance',
              purpose: 'resume the most recent pass instead of starting a second one',
            },
            {
              run: `export ACCEPTANCE_NAME_PREFIX="${config.namePrefix}-$(whoami)"`,
              purpose: 'take a per-person prefix, so two people share one board without colliding',
            },
          ],
        },
      )
    },
  },
  {
    id: 'cluster-connection',
    what: 'the k3s apiserver answers the supplied ServiceAccount token',
    disposition: 'required',
    check: async ({ client, config }) => {
      // The one probe that touches the cluster WITHOUT persisting anything. Its value is timing:
      // the same credential failure found by a `deployer` step arrives after a design pass and an
      // implementation have already been paid for.
      const result = await client.environments.testConnection({
        connection: buildK3sConnection(config.cluster),
        secrets: buildK3sSecrets(config.cluster),
      })
      const tls = config.cluster.caCertPem
        ? 'custom CA'
        : `insecureSkipTlsVerify=${config.cluster.insecureSkipTlsVerify}`
      return result.ok
        ? satisfied(`${config.cluster.apiServerUrl} answered (${tls})`)
        : unsatisfied(
            `the connection probe to ${config.cluster.apiServerUrl} (${tls}) failed: ` +
              `${result.message ?? '(no message)'}`,
            {
              steps: [
                'Check the three things this probe cannot tell apart from its answer, in order: ' +
                  'the apiserver is reachable at that URL, the token is still valid, and the ' +
                  'ServiceAccount may create NAMESPACES cluster-wide (per-PR namespaces are the ' +
                  'first thing a deployer step does).',
                'The commands below assume the `cat-factory` namespace and ServiceAccount from ' +
                  `the manifest in ${K3S_DOC}; substitute your own names if you wired it by hand.`,
                'A token minted against a cluster that has since been recreated (a k3d delete and ' +
                  'create) is the most common cause, and it fails exactly like a permission problem.',
              ],
              commands: [
                {
                  run: 'kubectl cluster-info',
                  purpose: 'confirm the cluster is up and which apiserver URL it answers on',
                },
                {
                  run: 'kubectl auth can-i create namespaces --as=system:serviceaccount:cat-factory:cat-factory',
                  purpose: 'check the cluster-wide binding the ephemeral environments need',
                },
                {
                  run: "kubectl -n cat-factory get secret cat-factory-token -o jsonpath='{.data.token}' | base64 -d",
                  purpose:
                    'print the current ServiceAccount token, to re-export as ACCEPTANCE_K3S_TOKEN',
                },
                {
                  run: 'npx @cat-factory/cli k3s',
                  purpose: 'guided setup: provisions the cluster, ServiceAccount, RBAC and token',
                },
              ],
              docs: K3S_DOC,
            },
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
            {
              steps: [
                'Build the template from {{namespace}} only: it is the one value known before a ' +
                  'run opens its pull request, so {{branch}} and {{pullNumber}} leave a hole the ' +
                  'suite cannot fill.',
                'The default below needs no DNS: nip.io resolves <anything>.127.0.0.1 to loopback.',
                'Unsetting the variable is also a fix, since the default is what it falls back to.',
              ],
              commands: [
                {
                  run: `export ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE='{{namespace}}.127.0.0.1.nip.io'`,
                  purpose: 'use the documented default, which renders from {{namespace}} alone',
                },
              ],
              docs: K3S_DOC,
            },
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
            {
              steps: [
                'Nothing to do. Stated because a pipeline that then fails to adopt looks like a ' +
                  'broken start, and this note is what tells the two apart.',
              ],
            },
          )
    },
  },
]
