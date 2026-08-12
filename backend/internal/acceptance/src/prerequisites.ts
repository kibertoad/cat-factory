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
  ListPublicAvailableReposResponseRepo,
  ListPublicModelPresetsResponsePreset,
  ListPublicReposResponseRepo,
  ListPublicWiredModelsResponseModel,
  PrReportRunProvider,
} from '@cat-factory/sdk'
import {
  blockedRepoMessage,
  describeVisibleRepos,
  findRepo,
  repoBlocker,
  sameRepo,
  unreachableRepoSteps,
} from './adopt.ts'
import type { DeploymentApi } from './deploymentApi.ts'
import type { AcceptanceConfig } from './config.ts'
import { buildK3sConnection, buildK3sSecrets, renderEnvironmentHost } from './k3s.ts'
import {
  envAssignment,
  perPersonPrefixInvocation,
  resetInvocation,
  resumeInvocation,
  shellQuoted,
} from './operatorText.ts'
import type { Prerequisite, PrerequisiteVerdict, Remedy, RemedyCommand } from './preflight.ts'
import { baseUrlStep } from './probeFailure.ts'
import type { PassOwnership } from './world.ts'
import { usablePresets } from './presets.ts'
import { describeKeyProblem, type KeyProblem, type PublicIdentity } from './publicApi.ts'
import { type IssueApi, issueTarget, slug, UNSUPPORTED_PROVIDER_REASON } from './vcsIssues.ts'

export type PreflightContext = {
  config: AcceptanceConfig
  client: CatFactoryClient
  deployment: DeploymentApi
  /** Board titles this pass will use. Supplied rather than derived: `instructions.ts` owns them. */
  serviceTitles: readonly string[]
  /**
   * The service ids THIS pass's ledger already names, i.e. non-empty on a RESUMED pass.
   *
   * The ids rather than a boolean, because `target-repos` has to tell "this repository backs the
   * service I adopted yesterday" from "this repository backs someone else's, and I happen to have
   * adopted the OTHER one". A flag derived from `backend ?? frontend` answers true for both, so a
   * verdict built on it states ownership it never read, and the pass then silently shares a frame
   * with a colleague's.
   */
  adoptedServiceIds: readonly string[]
  /**
   * The OTHER passes on disk whose ledgers name any of these services, and which ones each holds.
   *
   * What makes "resume that pass instead" an instruction rather than a suggestion. Both checks that
   * refuse over leftover state used to offer `latest`, and `latest` is the wrong pass the moment
   * anything ran after the one holding the work: typically the operator's own refused attempt from
   * a minute ago. A lookup rather than a value because it costs a directory read, and a satisfied
   * pass should read no ledger but its own.
   *
   * Which services each pass holds, rather than a flat list of ids, because two passes routinely
   * hold one board between them and the remedy has to say what resuming either one leaves behind.
   */
  passesNaming: (serviceIds: readonly string[]) => readonly PassOwnership[]
  /**
   * The reporter's issue client for a provider, or null when this suite cannot address that
   * provider's API (`vcsIssues.ts` owns which, and why).
   *
   * Supplied rather than built here, for the reason every other collaborator is: `harness.ts` holds
   * the credential, and a unit test drives the gate with no network. Required rather than optional
   * so a facade that forgot to wire it fails to typecheck instead of reporting a satisfied
   * prerequisite it never checked.
   */
  issueApiFor: (provider: PrReportRunProvider) => IssueApi | null
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
    run:
      `curl -sS -H "Authorization: Bearer $CAT_FACTORY_API_KEY" ` +
      shellQuoted(`${config.baseUrl}/api/v1${path}`),
    purpose,
  }
}

/**
 * A `curl` that CHANGES something through `/api/v1`, for the remedies whose fix this suite's own key
 * can carry out.
 *
 * Offered only where the alternative is a screen: a workspace setting the public API can now write
 * is one an operator running a headless pass should not have to open a browser for, and the whole
 * point of the `tracker-writeback` gate below is that the loop it grades is meant to work with
 * nobody in the app.
 */
function publicApiWrite(
  config: AcceptanceConfig,
  method: string,
  path: string,
  body: string,
  purpose: string,
): RemedyCommand {
  return {
    run:
      `curl -sS -X ${method} -H "Authorization: Bearer $CAT_FACTORY_API_KEY" ` +
      `-H 'content-type: application/json' -d '${body}' ` +
      shellQuoted(`${config.baseUrl}/api/v1${path}`),
    purpose,
  }
}

/**
 * Read a pass without touching the deployment: the first thing to run when leftovers are in the way.
 *
 * NAMED whenever there is a pass to name. The bare form reports whichever pass ran last, and in the
 * situation this remedy exists for that is reliably the refused attempt the operator is standing in,
 * not the pass that owns the leftovers being discussed.
 */
function statusRead(runId?: string): RemedyCommand {
  const command = 'pnpm --filter @cat-factory/acceptance run status'
  return runId
    ? { run: `${command} ${runId}`, purpose: `show what pass ${runId} got to, without touching it` }
    : {
        run: command,
        purpose: 'show the pass that ran last and its run id, without touching the deployment',
      }
}

/**
 * "Clear it and start over", as a step plus the two commands that do it.
 *
 * The other half of {@link resumeTheOwningPass}, and the half that was not a command until
 * `DELETE /api/v1/services/{serviceId}` existed: "delete the service frame that holds this one" was
 * an app act, so the one way out of this refusal that a HEADLESS pass could act on headlessly was the
 * one that continues somebody else's work. Both remedies now name a command, which is the whole point
 * of the pair: an operator chooses between continuing the pass and clearing it, rather than between
 * an instruction and a browser.
 *
 * The PREVIEW is offered first, and that ordering is the safety property rather than politeness: the
 * apply deletes service frames, their tasks and their run history on a board two people may share,
 * and the preview names every one of them. What it cannot reclaim (the repositories' contents above
 * all) it states, which is why this step does not promise a board that looks freshly created.
 *
 * EVERY owning pass is named, one invocation each, for the same reason {@link resumeTheOwningPass}
 * emits one resume per owner: a reset clears ONE named pass plus what this configuration points at,
 * so a single command over a two-pass board leaves the other pass's ledger behind and the operator
 * who followed the printed "clear all of it" is refused again by the frame it still maps.
 */
function clearAndStartOver(owners: readonly PassOwnership[]): {
  step: string
  commands: readonly RemedyCommand[]
} {
  const scope =
    owners.length > 1
      ? `Run it once per owning pass (${owners.map((pass) => pass.runId).join(', ')}): a reset ` +
        `clears one named pass plus what this configuration points at, so one invocation would ` +
        `leave the others' ledgers naming frames that are gone.`
      : `It prints what it would do and changes nothing until --yes.`
  return {
    step:
      `Or CLEAR it and start clean: the reset below deletes the service frames this configuration ` +
      `would adopt (with their tasks and run history) and the local files of the passes that name ` +
      `them, over the same /api/v1 key this suite already holds. ${scope} It states what no key can ` +
      `reclaim: the two repositories keep whatever a previous pass scaffolded, so a fresh pass ` +
      `builds on top of that unless you empty them yourself.`,
    commands:
      owners.length === 0
        ? [
            {
              run: resetInvocation(),
              purpose: 'show what a reset would delete, without touching anything',
            },
            { run: resetInvocation({ apply: true }), purpose: 'carry that out' },
          ]
        : owners.flatMap((pass) => [
            {
              run: resetInvocation({ runId: pass.runId }),
              purpose: `show what clearing pass ${pass.runId} would delete, without touching anything`,
            },
            {
              run: resetInvocation({ runId: pass.runId, apply: true }),
              purpose: `carry that out for ${pass.runId}`,
            },
          ]),
  }
}

/**
 * "Resume the pass that owns this instead", as a step plus the commands that do it.
 *
 * Shared by the two checks that refuse over another pass's leftover state, so both name the SAME
 * pass: one reasons about repository links and the other about frame titles, and an operator handed
 * two different remedies for one board has to work out which is true.
 *
 * A NAMED pass rather than `latest`, which is what this replaced. `latest` follows the pointer to
 * whichever pass last recorded a fact, and by the time anyone reads a refusal that is routinely not
 * the pass holding the work; the id is the one thing the operator cannot recover from the board.
 * Naming no pass is stated rather than hidden: it means the state was built somewhere else (another
 * machine, another operator, another `ACCEPTANCE_STATE_DIR`), and resuming is not on the table.
 *
 * Leftovers SPANNING two passes get their own wording, because "resume one of them" is not an
 * instruction there: resuming A leaves B's service in the way, this same check refuses again, and
 * naming B the second time sends the reader back to A. So the split is stated with the services each
 * pass holds, and the choice it actually leaves (continue one and clear the other's leftovers, which
 * is the step each caller adds after this one) is named as such.
 */
function resumeTheOwningPass(owners: readonly PassOwnership[]): {
  step: string
  commands: readonly RemedyCommand[]
} {
  // The LAST id, which for a minted one (a timestamp) is the most recent attempt. Every match is
  // named in the step, so a hand-named id that sorts oddly still puts the choice in front of a
  // reader rather than resolving it silently.
  const owner = owners.at(-1)
  if (!owner) {
    return {
      step:
        'No ledger under ACCEPTANCE_STATE_DIR names it, so it was built by another operator, ' +
        'another machine, or a pass whose state directory has since been cleared. Nothing here can ' +
        'be resumed onto it.',
      commands: [statusRead()],
    }
  }
  const commands = owners.flatMap((pass) => [
    {
      run: resumeInvocation(pass.runId),
      purpose: `resume pass ${pass.runId}, which owns ${pass.serviceIds.join(' and ')}`,
    },
    statusRead(pass.runId),
  ])
  if (owners.length === 1) {
    return {
      step:
        `Pass ${owner.runId} is the one whose ledger names it: RESUME that pass rather than ` +
        `starting over, and the leftover state becomes the state it continues from.`,
      commands,
    }
  }
  return {
    step:
      `This state belongs to ${owners.length} different passes ` +
      `(${owners.map((pass) => `${pass.runId} holds ${pass.serviceIds.join(' and ')}`).join('; ')}), ` +
      `and no single resume continues all of it: resuming one leaves the others' services in the ` +
      `way and earns this same refusal. RESUME the pass whose work is worth keeping ` +
      `(${owner.runId} is the most recent) and clear what the others left, or clear all of it and ` +
      `start clean.`,
    commands,
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
  const usable = usablePresets(presets, models)
  return usable.map((preset) => `${preset.presetId} ('${preset.name}')`).join(', ') || '(none)'
}

/**
 * The two ways an unusable key is unusable, and the fix for each.
 *
 * A `Record` over the closed `KeyProblem['code']` rather than a `switch`: adding a third failure
 * to `describeKeyProblem` then fails to compile here instead of quietly falling through to a
 * remedy written for a different problem.
 */
/**
 * The fields both repository reads publish about whether a repository is spoken for.
 *
 * A structural type over the two SDK row shapes rather than a union of them: `GET /api/v1/repos`
 * and `GET /api/v1/repos/available` answer this from the SAME account-scoped judgement, so the gate
 * applies one rule to both populations and gains nothing from knowing which read a row came from.
 */
type RepoRowWithUse = Pick<
  ListPublicReposResponseRepo & ListPublicAvailableReposResponseRepo,
  'owner' | 'name' | 'serviceId' | 'linkedElsewhere' | 'monorepo'
>

const KEY_REMEDIES: Record<
  KeyProblem['code'],
  (identity: PublicIdentity, config: AcceptanceConfig) => Remedy
> = {
  'workspace-mismatch': (identity, config) => ({
    steps: [
      `The key names workspace ${identity.workspaceId}; ACCEPTANCE_WORKSPACE_ID names ` +
        `${config.workspaceId}. Decide which board this pass belongs to, then move the other one.`,
      'To keep the key, point the suite at the board the key already names (the command below).',
      'To keep the board, mint a token on it: in the SPA, Integrations, "API access tokens", ' +
        'Create a token with scope "Full access", then set it as CAT_FACTORY_API_KEY. The ' +
        'secret is shown once and cannot be recovered.',
    ],
    commands: [
      {
        run: envAssignment('ACCEPTANCE_WORKSPACE_ID', identity.workspaceId),
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
      '"Full access" is the rung that carries both what scenario 01 needs (creating services) and ' +
        'what scenario 03 needs (answering a parked human gate).',
      'Export the new secret as CAT_FACTORY_API_KEY, then revoke the old token.',
    ],
    commands: [publicApiRead(config, '/me', 'confirm the new key is admin on this workspace')],
  }),
}

/**
 * The three ways the reporter credential is unusable, and what each one is.
 *
 * `Record`s over the closed verdict vocabulary rather than a `switch`, exactly as `KEY_REMEDIES`
 * above: a fourth verdict added to `IssueCredentialVerdict` then fails to compile here instead of
 * quietly inheriting a message written for a different fault. `ready` and `unreadable` are handled
 * at the call site (one is not a problem, the other is not a verdict), which is why they are absent.
 */
type IssueCredentialFault = 'unauthenticated' | 'unreachable' | 'issues-disabled'

const ISSUE_CREDENTIAL_PROBLEMS: Record<IssueCredentialFault, (repo: string) => string> = {
  unauthenticated: () =>
    'the provider rejected ACCEPTANCE_VCS_TOKEN outright (401), so it is expired, revoked, or not ' +
    'a token for this host',
  unreachable: (repo) =>
    `the reporter credential cannot see ${repo} (404). A repository that does not exist answers ` +
    'exactly as one the token is not granted, so this names both',
  'issues-disabled': (repo) =>
    `${repo} has its Issues feature switched off, so no credential can open an issue on it`,
}

const ISSUE_CREDENTIAL_STEPS: Record<IssueCredentialFault, (repo: string) => readonly string[]> = {
  unauthenticated: () => [
    'Mint a new token and set it as ACCEPTANCE_VCS_TOKEN. A token scope cannot be widened in ' +
      'place, and an expired one cannot be renewed.',
    'GitHub classic: the `repo` scope. Fine-grained: "Issues: Read and write" on the target ' +
      'repository, which is the narrower and better choice.',
    '`pnpm --filter @cat-factory/acceptance run configure` opens the minting page with the ' +
      'description and scopes prefilled.',
  ],
  unreachable: (repo) => [
    `Check that ${repo} exists under ACCEPTANCE_REPO_OWNER: it is the repository the backend ` +
      'service adopts, and the reporter files against the same one.',
    'Grant this token access to it. A fine-grained token lists repositories explicitly, so one ' +
      'minted for the other repository answers exactly like a repository that is not there.',
    'A classic token needs `repo` to see a private repository at all.',
  ],
  'issues-disabled': (repo) => [
    `Turn Issues on for ${repo}: its Settings, "Features", tick "Issues".`,
    'Nothing else about the pass needs it, so this is a one-click fix rather than a re-mint.',
  ],
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
            // What is specific to THIS verdict, then the shared re-read step. The instruction itself
            // is `probeFailure.ts`'s and is relayed rather than restated: three near-copies of one
            // sentence lived in this package, each worded slightly differently.
            'The SPA serves a /health of its own, and a base URL pointing at it produces exactly ' +
              'this verdict against a backend that is perfectly healthy.',
            baseUrlStep(config.baseUrl),
          ],
          commands: [
            {
              run: `curl -sS ${shellQuoted(`${config.baseUrl}/health`)}`,
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
              run: `curl -sS ${shellQuoted(`${config.baseUrl}/auth/config`)}`,
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
      // Models the deployment CONFIRMED are wired to this key's owner as a personal subscription
      // AND that the policy does not refuse. A third cause with a third fix, and the only one that
      // says the deployment is already correct: what is missing is the token's identity, not a
      // credential. Policy-refused rows are excluded rather than merely ranked below, because a
      // catalog that mixes the two causes still owes the policy answer for its blocked half: a
      // re-minted token cannot spend what the policy refuses.
      const connected = models.filter(
        (model) => model.subscriptionConfigured === true && !model.policyBlocked,
      )
      const catalogRead = publicApiRead(
        config,
        '/models',
        "list the catalog with each entry's `available`, `policyBlocked`, `personalSubscription` " +
          'and `subscriptionConfigured` flags',
      )
      // The policy answer FIRST, because it is the one cause no remedy below can undo. A catalog
      // refused end to end is refused for every identity, so reaching the identity answer first
      // told an operator "nothing is missing from the deployment" about a deployment whose policy
      // was the entire problem.
      if (blocked.length === models.length && models.length > 0) {
        return unsatisfied(
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
      }
      if (connected.length > 0) {
        return unsatisfied(
          `no model in the ${models.length}-entry catalog is selectable by THIS token, but ` +
            `${connected.map((model) => `'${model.modelId}'`).join(', ')} ` +
            `${connected.length === 1 ? 'runs' : 'run'} on a subscription that is connected for ` +
            `this token’s owner. Nothing is missing from the deployment: a system token may not ` +
            `spend a credential that belongs to a person.`,
          {
            steps: [
              'Mint the token again in the app under Integrations → API access tokens with ' +
                '"Runs as" set to yourself, and set it as CAT_FACTORY_API_KEY.',
              'The pass then asks for your personal password once, at the moment a run needs it, ' +
                'and stores it nowhere: not in .env, not in the ledger, not in a log line.',
              'Adding a provider key would also work and is the wrong fix here: it would pay per ' +
                'token for a model your subscription already covers.',
            ],
            commands: [catalogRead],
            docs: 'backend/docs/individual-subscription-usage.md',
          },
        )
      }
      return unsatisfied(
        `no model in the ${models.length}-entry catalog is selectable, so every agent step ` +
          `would fail at dispatch`,
        {
          steps: [
            'In the SPA: Model providers, and add a provider API key or connect a subscription ' +
              'for at least one model.',
            'An entry becomes selectable as soon as its provider is wired, with no restart.',
            // The THIRD cause, and the only one this read cannot see for itself: a deployment
            // whose models belong to a PERSON (a locally-run endpoint, a personal Claude /
            // Codex subscription) answers a SYSTEM token exactly like a deployment with
            // nothing wired, because such a token has no person to attribute them to. Naming
            // it here keeps the remedy from being "add a key" when a key is not what is
            // missing, and the remedy differs per kind, so both are stated.
            ...(excludesUserScopedModels
              ? [
                  'This token is a SYSTEM token, and the catalog above leaves out every model ' +
                    'that belongs to a person: a personal Claude / Codex / GLM subscription, ' +
                    'and any locally-run endpoint. If one of those is what this workspace ' +
                    'actually runs on, nothing is missing from the deployment.',
                  'For a personal SUBSCRIPTION: mint the token again under Integrations → API ' +
                    'access tokens with "Runs as" set to yourself, and the pass will ask for ' +
                    'your personal password once, when a run needs it.',
                  'For a locally-run ENDPOINT: those are per-user and never reachable by a ' +
                    'token, so the suite needs a provider key or a subscription of its own.',
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

      const { models, excludesUserScopedModels } = await client.models.list()
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
        // WHY it is not selectable, in the HEADLINE and not only three bullets down. The first line
        // is what an operator reads and acts on, so a model that is already wired as somebody's
        // personal subscription must not be announced as having no provider: that is the misreport
        // this whole path exists to remove, and burying the correction in `steps` leaves it intact
        // where it is read. Every signal below is the ROW's own answer, so it names THIS model
        // rather than inferring from a flag about the whole response.
        //
        // Four causes, ordered so a later one cannot undo an earlier one, and the three
        // `subscriptionConfigured` states stay APART because the deployment answered a different
        // question in each: it found the subscription, it found the owner and there was none, or it
        // found no owner to ask about. Folding the middle one into the last reported an ANSWERED
        // question as unanswerable, and sent an operator to re-mint a token that would resolve the
        // same person and the same absent subscription.
        const cause = base.policyBlocked
          ? ' (refused by the account model-family policy)'
          : base.subscriptionConfigured === true
            ? ' (it runs on a subscription that IS connected for this token’s owner, and this ' +
              'token is not bound to spend it)'
            : base.subscriptionConfigured === false
              ? ' (it runs on a personal subscription, and this token’s owner holds none for that ' +
                'vendor)'
              : base.personalSubscription
                ? ' (its credential belongs to a person, and this token resolved none, so whether ' +
                  'it is wired is unknown here)'
                : ' (no provider wired for it)'
        return unsatisfied(
          `preset '${preset.name}' runs on '${base.label}' (${base.modelId}), which is in the ` +
            `catalog but not selectable${cause}`,
          {
            steps: base.policyBlocked
              ? [
                  'The model is CONFIGURED and refused, so adding a provider key changes nothing: ' +
                    "permit its family on the account's model policy, or pin a preset whose model " +
                    'the policy already permits.',
                ]
              : // The one cause whose fix is not "wire something", and the deployment has CONFIRMED
                // it: the subscription is stored for this key's owner and only the key's identity
                // is in the way. Nothing else is worth offering underneath that, because nothing
                // else is wrong: an alternative preset here would talk an operator out of the
                // model they deliberately chose.
                base.subscriptionConfigured === true
                ? [
                    `'${base.modelId}' is already wired, as a PERSONAL subscription belonging to ` +
                      'the person this key was minted by. A system token may not spend one, which ' +
                      'is the whole of the problem: the deployment needs no change.',
                    'Mint the token again under Integrations → API access tokens with "Runs as" ' +
                      'set to yourself, and set it as CAT_FACTORY_API_KEY. The pass then asks ' +
                      'for your personal password once, when a run needs it, and stores it nowhere.',
                  ]
                : [
                    // Stated FIRST when it applies: the provider MAY already be wired, as a
                    // credential belonging to a person this read could not resolve. Two signals can
                    // say so, and only when the question was left OPEN: the row for a personal
                    // subscription that IS listed but unjudged, the response flag for a locally-run
                    // endpoint that is not listed at all. A row already answered `false` is
                    // excluded, because re-minting resolves the same person and the same absence.
                    ...((base.personalSubscription && base.subscriptionConfigured !== false) ||
                    excludesUserScopedModels
                      ? [
                          `'${base.modelId}' may be wired as a PERSONAL subscription this token ` +
                            'cannot see. Mint the token IN THE APP (Integrations → API access ' +
                            'tokens) with "Runs as" set to yourself; the pass then asks for your ' +
                            'personal password once, when a run needs it, and stores it nowhere.',
                        ]
                      : []),
                    // The answered-and-absent case, which reads as the opposite instruction: this
                    // deployment DID resolve the owner, so the missing thing is the subscription
                    // itself and re-minting the token would change nothing.
                    ...(base.subscriptionConfigured === false
                      ? [
                          `'${base.modelId}' runs on a personal subscription and this key's owner ` +
                            'holds none, so re-minting the token changes nothing: connect one in ' +
                            'the app (Model providers, "Personal subscriptions"), or pin a preset ' +
                            'whose model this workspace already has a provider for.',
                        ]
                      : []),
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
          `Either point the suite at the connected account (the command below), or re-connect the ` +
            `workspace to '${config.repoOwner}' under Integrations.`,
        )
        commands.push({
          run: envAssignment('ACCEPTANCE_REPO_OWNER', connection.accountLogin),
          purpose: 'adopt the repositories under the account already connected',
        })
      }
      if (!connection.canManageWorkflows) {
        // The scaffold runs ship a build-and-push workflow, and scenario 02 asserts a real CI gate.
        // Without `workflows: write` the provider REJECTS the push that adds it, which surfaces as
        // a scaffold pull request that half-worked.
        problems.push(
          'it was not granted permission to write workflow files, so the scaffolded CI workflow ' +
            "cannot be pushed and scenario 02's CI gate has nothing to gate on",
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
    what: 'both repositories this pass adopts are reachable, and neither is already in use',
    disposition: 'required',
    check: async ({ client, config, adoptedServiceIds, passesNaming }) => {
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

      // A repository this workspace has not LINKED is not a refusal any more: scenario 01 adopts one
      // through `POST /api/v1/repos/link`. So what this gate has to establish about an unlisted
      // repository is REACHABILITY, which is a different read, and the only refusal left is the one
      // no API can fix for an operator.
      //
      // One EXACT-SLUG query per unlisted repository rather than one browse-all for both: an
      // `owner/name` query is resolved by a direct point-read, which is authoritative where an
      // enumeration truncates at its cap and a name search can miss an exact slug. At most two calls,
      // and only for what the first read did not answer.
      const unlisted = found.filter((entry) => !entry.repo)
      const reachable: ListPublicAvailableReposResponseRepo[] = []
      const unreachable: typeof unlisted = []
      for (const entry of unlisted) {
        const { repos: exact } = await client.repos.listAvailable({
          q: `${config.repoOwner}/${entry.name}`,
        })
        const hit = findRepo(exact, config.repoOwner, entry.name)
        if (hit) reachable.push(hit)
        else unreachable.push(entry)
      }

      if (unreachable.length > 0) {
        // A second query per miss, by NAME alone, and only on the failing path: the slug query above
        // answers reachability and cannot surface a look-alike (a search for `intended/foo` does not
        // match `someone-else/foo`), which is the one observation that separates a typo in
        // ACCEPTANCE_REPO_OWNER from a credential that reaches nothing at all.
        const nearby: { owner: string; name: string }[] = []
        // Whether the SERVER capped any of those searches, which is not the same as this message's
        // own display cap: a truncated search means the look-alike hunt itself was incomplete, so
        // "reached no repositories at all" would be a stronger claim than what was observed.
        let searchCapped = false
        for (const entry of unreachable) {
          const { repos: byName, truncated } = await client.repos.listAvailable({ q: entry.name })
          nearby.push(...byName.map((repo) => ({ owner: repo.owner, name: repo.name })))
          searchCapped ||= truncated
        }
        const seen = nearby.filter(
          (repo) => !unreachable.some((entry) => sameRepo(repo, config.repoOwner, entry.name)),
        )
        // The steps come from `adopt.ts` rather than being written here: this gate, `configure`'s
        // check and the adopt itself all answer one question, and three copies of the answer is three
        // places for one of them to fall out of step with what the platform now does for itself.
        return unsatisfied(
          `${unreachable.map((entry) => `'${config.repoOwner}/${entry.name}'`).join(' and ')} ` +
            `${unreachable.length === 1 ? 'is' : 'are'} not reachable by this workspace's ` +
            `connection: neither GET /api/v1/repos nor a point-read of ` +
            `GET /api/v1/repos/available finds ${unreachable.length === 1 ? 'it' : 'them'}, and a ` +
            `repository that does not exist answers exactly as one the credential is not granted. ` +
            `Searching the ${unreachable.length === 1 ? 'name' : 'names'} alone reached ` +
            `${describeVisibleRepos(seen)}` +
            (searchCapped
              ? `. That search stopped at the provider's cap, so it is not a complete list of what ` +
                `the connection can see; the point-read above is what settles reachability`
              : ''),
          {
            steps: [
              ...unreachableRepoSteps(
                seen,
                unreachable.map((entry) => ({ owner: config.repoOwner, name: entry.name })),
              ),
              'The `configure` command below opens a prefilled creation page per repository and ' +
                're-checks reachability, so the next click is the thing the suite needs.',
            ],
            commands: [
              {
                run: 'pnpm --filter @cat-factory/acceptance run configure',
                purpose: 'create each missing repository, then re-check',
              },
              publicApiRead(
                config,
                `/repos/available?q=${config.repoOwner}/${unreachable[0]?.name ?? ''}`,
                'point-read one repository, which answers reachability rather than linkage',
              ),
            ],
          },
        )
      }

      // Both populations, because both can be spoken for. A repository this workspace has not
      // adopted is NOT free by construction: `linkedElsewhere` is an ACCOUNT-scoped judgement, so a
      // repository already backing a service on another board of the account answers it whether or
      // not this board links it, and the create refuses it either way. Treating "unlinked" as
      // "available" let exactly that case through the gate, to be caught mid-pass by the adopt's own
      // `repo_service_homed_elsewhere` refusal, after the run this gate exists to precede.
      //
      // The two row shapes carry the same fields for this (`serviceId`, `linkedElsewhere`,
      // `monorepo`), which is what lets one judgement cover them: `repoBlocker` is generic over
      // exactly that pair. Narrowed through a predicate rather than asserted with `!`, so a row that
      // stopped being present renders as absent rather than as `undefined/undefined` inside the
      // verdict a reader would rely on.
      const adopted = found.flatMap((entry) => (entry.repo ? [entry.repo] : []))
      const resolved: RepoRowWithUse[] = [...adopted, ...reachable]

      // A repository this workspace can SEE but cannot back a service with. Checked before the
      // ledger comparison below because neither cause has anything to do with which pass this is:
      // `linkedElsewhere` is a service whose id this surface deliberately withholds (so `serviceId`
      // is null and reading only that field reads it as available), and a monorepo needs a
      // subdirectory this suite does not configure. `adopt.ts` refuses the same two for the same
      // reasons, and owns the wording, including the fact that `linkedElsewhere` covers TWO states
      // with opposite fixes: homed on another board, or ARCHIVED here.
      const blocked = resolved.flatMap((repo) => {
        const blocker = repoBlocker(repo)
        return blocker ? [{ slug: `${repo.owner}/${repo.name}`, blocker }] : []
      })
      if (blocked.length > 0) {
        return unsatisfied(
          `${blocked
            .map(({ slug, blocker }) =>
              blocker === 'monorepo'
                ? `'${slug}' is registered as a MONOREPO`
                : `'${slug}' already backs a service this workspace cannot name (homed on ` +
                  `ANOTHER board of this account, or ARCHIVED here)`,
            )
            .join(', ')}, so POST /api/v1/services cannot back a frame with it`,
          {
            // `adopt.ts` owns the wording, one sentence per step, so the gate's remedy and the
            // adopt's own refusal cannot come to describe different fixes.
            steps: blocked.flatMap(({ slug, blocker }) => [...blockedRepoMessage(slug, blocker)]),
            commands: [repoRead],
          },
        )
      }

      // A repository already backing a service is the REPO half of what `board-titles` catches for
      // frames, and it needs the same split: on a resumed pass the link is this pass's OWN and is
      // the point, on any other pass it means the frame would be a second one over someone's
      // repository. Decided by comparing the projection's `serviceId` against the ledger's ids,
      // never by "is this a resume at all": a ledger holding only the backend service makes that
      // question answer yes for the frontend repository too, which is how two passes end up sharing
      // a frame.
      const owned = new Set(adoptedServiceIds)
      const taken = resolved.flatMap((repo) =>
        repo.serviceId && !owned.has(repo.serviceId)
          ? [{ slug: `${repo.owner}/${repo.name}`, serviceId: repo.serviceId }]
          : [],
      )
      if (taken.length > 0) {
        const owners = passesNaming(taken.map((entry) => entry.serviceId))
        const owning = resumeTheOwningPass(owners)
        const clearing = clearAndStartOver(owners)
        return unsatisfied(
          `${taken.map((entry) => `'${entry.slug}' already backs service ${entry.serviceId}`).join(', ')}` +
            `, which this pass's ledger does not name` +
            (adoptedServiceIds.length > 0
              ? ` (it names ${adoptedServiceIds.join(', ')})` +
                `. Continuing would adopt a frame belonging to another pass, and file this pass's ` +
                `work under it.`
              : `. A fresh pass would adopt a repository whose work belongs to another pass, and ` +
                `its scaffold run would open a pull request against a tree that is already built.`),
          {
            steps: [
              owning.step,
              clearing.step,
              'Or point ACCEPTANCE_BACKEND_REPO / ACCEPTANCE_FRONTEND_REPO at two fresh empty ' +
                'repositories, which leaves this board as it stands.',
            ],
            commands: [...owning.commands, ...clearing.commands, repoRead],
          },
        )
      }

      // Emptiness is STATED, never graded, and this is the one thing this check deliberately does
      // not claim. No `/api/v1` read publishes whether a repository holds content: the bootstrapper
      // used to answer it inside its container pre-flight, and putting it on the repository LIST
      // would mean one provider round-trip per row on every call. What a non-empty target actually
      // costs is a scaffold run that builds on top of whatever is there, which is a strange result
      // rather than a failure, so the honest disposition is to say the probe cannot see it.
      const mine = adopted.filter((repo) => repo.serviceId && owned.has(repo.serviceId))
      // The two populations are reported separately, because they are two different states of the
      // setup and only one of them has been through the checks above: an ADOPTED repository was read
      // with its links and flags, where a merely reachable one is a promise that scenario 01 will link it.
      const linkedNote =
        adopted.length > 0
          ? `${adopted.map((repo) => `${repo.owner}/${repo.name}`).join(' and ')} ` +
            (mine.length > 0
              ? `${mine.length === adopted.length ? 'are both' : `include ${mine.length}`} backed by ` +
                `a service this pass's own ledger names`
              : 'are adopted and back no service yet')
          : ''
      const pendingNote =
        reachable.length > 0
          ? `${reachable.map((repo) => `${repo.owner}/${repo.name}`).join(' and ')} ` +
            `${reachable.length === 1 ? 'is' : 'are'} reachable but not adopted yet, which scenario 01 ` +
            `does itself (POST /api/v1/repos/link)`
          : ''
      return satisfied(
        `${[linkedNote, pendingNote].filter((note) => note !== '').join('; ')} (whether either is ` +
          `EMPTY is not readable over /api/v1; a repository with content is scaffolded on top of)`,
      )
    },
  },
  {
    id: 'issue-credential',
    what: "ACCEPTANCE_VCS_TOKEN can open an issue on the repository scenario 04's reporter files against",
    disposition: 'required',
    check: async ({ client, config, issueApiFor }) => {
      // Scenario 04's premise is an issue filed by somebody OUTSIDE this deployment, so the credential
      // that files it is not the workspace's connection and nothing checked so far says anything
      // about it. Checked here rather than discovered at the top of scenario 04, because by then the
      // pass has already scaffolded two repositories and shipped two features.
      const target = issueTarget(config)
      const { connection } = await client.vcs.getConnection()
      if (!connection) {
        // `vcs-connection` above has already refused this, with the remedy. Repeating its
        // instructions would be a second, staler copy of them; what this one owes is not to claim a
        // verdict it cannot reach.
        return {
          status: 'unknown',
          probeFailure:
            'the workspace has no VCS connection, so which provider the reporter should file on ' +
            'is unknown (see vcs-connection above)',
          remedy: {
            steps: [
              'Fix vcs-connection first: the provider decides which API this credential is even ' +
                'checked against.',
            ],
          },
        }
      }
      const api = issueApiFor(connection.provider)
      if (!api) {
        return unsatisfied(
          `this suite cannot file an issue on '${connection.provider}', which is what this ` +
            `workspace is connected to, so scenario 04 has no way to act as the reporter`,
          {
            steps: [...UNSUPPORTED_PROVIDER_REASON[connection.provider]],
            docs: 'backend/internal/acceptance/README.md',
          },
        )
      }
      const verdict = await api.probe(target)
      if (verdict.status === 'ready') {
        return satisfied(
          `the reporter credential reaches ${slug(target)} and it accepts issues ` +
            `(via ${config.vcs.apiBaseUrl})`,
        )
      }
      if (verdict.status === 'unreadable') {
        return {
          status: 'unknown',
          probeFailure:
            `${config.vcs.apiBaseUrl} could not be read (${verdict.detail}), so whether the ` +
            `reporter credential works is unknown rather than answered no`,
          remedy: {
            steps: [
              // The probe's own hint FIRST when it has one: it is kernel's per-cause remedy for the
              // failure that actually happened (nothing listening, a name that does not resolve, an
              // untrusted certificate), which is strictly more than the three candidates below.
              ...(verdict.hint ? [verdict.hint] : []),
              `Check that ${config.vcs.apiBaseUrl} is reachable from here (a proxy, a VPN, or an ` +
                'Enterprise Server host that is down).',
              'ACCEPTANCE_VCS_API_BASE overrides the base: an Enterprise Server API lives at ' +
                'https://<host>/api/v3, which nothing in /api/v1 publishes.',
            ],
          },
        }
      }
      return unsatisfied(ISSUE_CREDENTIAL_PROBLEMS[verdict.status](slug(target)), {
        steps: ISSUE_CREDENTIAL_STEPS[verdict.status](slug(target)),
        commands: [
          {
            run:
              `curl -sS -o /dev/null -w '%{http_code}\\n' ` +
              `-H "Authorization: Bearer $ACCEPTANCE_VCS_TOKEN" ` +
              shellQuoted(`${config.vcs.apiBaseUrl}/repos/${target.owner}/${target.repo}`),
            purpose:
              'read the target repository with the reporter credential: 200 is ready, 401 is the ' +
              'token, 404 is the repository or its access',
          },
        ],
      })
    },
  },
  {
    id: 'tracker-writeback',
    what: 'the workspace writes back to a linked tracker issue when its pull request opens and merges',
    disposition: 'required',
    check: async ({ client, config }) => {
      // The two actions scenario 04's final claim is made of. Both are ON for a workspace that has never
      // configured them (`DEFAULT_TRACKER_WRITEBACK`), so this gate fires only where somebody
      // deliberately turned one off, and it then refuses BEFORE the pass spends an afternoon
      // delivering an issue nobody will close.
      const { writeback, updatedAt } = await client.tracker.getWriteback()
      const chosen = updatedAt === null ? 'the deployment defaults' : "this workspace's own setting"
      const off = [
        ...(writeback.resolveOnMerge ? [] : ['resolveOnMerge']),
        ...(writeback.commentOnPrOpen ? [] : ['commentOnPrOpen']),
      ]
      if (off.length === 0) {
        return satisfied(
          `comment-on-open and resolve-on-merge are both on, from ${chosen}` +
            (writeback.questionsOnPark
              ? ''
              : ' (questionsOnPark is off, which scenario 04 does not use)'),
        )
      }
      return unsatisfied(
        `${off.join(' and ')} ${off.length === 1 ? 'is' : 'are'} off for this workspace, from ` +
          `${chosen}. Scenario 04 asserts the platform CLOSED the issue it delivered and commented on ` +
          `it at both edges of the pull request's life, and neither happens with these off.`,
        {
          steps: [
            'Turn both on for this workspace. The command below does it over the same API the ' +
              'suite uses; the SPA equivalent is Workspace settings, "Issue tracker".',
            'It is a MERGE, so it moves only the two actions it names and leaves the filing ' +
              'selection and questionsOnPark as they are.',
            'Both are on by default, so a workspace reporting them off had them turned off ' +
              'deliberately: prefer a board of your own over re-pointing one somebody relies on.',
          ],
          commands: [
            publicApiWrite(
              config,
              'PATCH',
              '/tracker/writeback',
              '{"writeback":{"commentOnPrOpen":true,"resolveOnMerge":true}}',
              'turn both writeback actions on for this workspace',
            ),
            publicApiRead(config, '/tracker/writeback', 'read the disposition back'),
          ],
        },
      )
    },
  },
  {
    id: 'auto-merge-policy',
    what: 'the default risk policy permits the auto-merge every scenario ends on',
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
    check: async ({ client, config, serviceTitles, adoptedServiceIds, passesNaming }) => {
      const { services } = await client.services.list()
      const taken = serviceTitles.filter((title) =>
        services.some((service) => service.title === title),
      )
      // A TITLE cannot be traced to a ledger id the way `target-repos`' repository link can, so this
      // one still keys off whether the ledger names anything at all: a duplicate title is a naming
      // collision rather than a claim about who owns what, and `target-repos` is where ownership is
      // established per repository.
      const resuming = adoptedServiceIds.length > 0
      if (taken.length === 0 || resuming) {
        // On a RESUMED pass the frames existing is the point: the ledger names them and scenario 01
        // re-reads the board to confirm they are still there.
        return satisfied(
          resuming
            ? 'resuming a pass whose services the ledger already names'
            : `neither '${serviceTitles.join("' nor '")}' exists on this board yet`,
        )
      }
      // The frames' own ids, which is how a TITLE reaches a ledger: the ledger records service ids
      // and never titles, so the pass to resume is found through what the board just answered.
      const owners = passesNaming(
        services.flatMap((service) => (taken.includes(service.title) ? [service.serviceId] : [])),
      )
      const owning = resumeTheOwningPass(owners)
      const clearing = clearAndStartOver(owners)
      return unsatisfied(
        `this board already has ${taken.map((title) => `'${title}'`).join(' and ')}, but this ` +
          `pass’s ledger names no services. A fresh pass would raise a SECOND frame under the ` +
          `same title, and a later resume would have no way to tell the two apart.`,
        {
          steps: [
            owning.step,
            `If they belong to someone else, take a prefix of your own (today's is ` +
              `'${config.namePrefix}'), which renames every service frame and task this pass ` +
              'creates. The repository names are ACCEPTANCE_BACKEND_REPO / ' +
              'ACCEPTANCE_FRONTEND_REPO and move separately.',
            clearing.step,
          ],
          commands: [
            ...owning.commands,
            {
              run: perPersonPrefixInvocation(config.namePrefix),
              purpose: 'take a per-person prefix, so two people share one board without colliding',
            },
            ...clearing.commands,
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
                    'print the current ServiceAccount token, to set again as ACCEPTANCE_K3S_TOKEN',
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
                  run: envAssignment(
                    'ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE',
                    '{{namespace}}.127.0.0.1.nip.io',
                  ),
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
