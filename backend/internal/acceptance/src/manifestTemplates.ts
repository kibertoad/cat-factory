// The two prerequisites that grade the templates the suite writes into its own briefs.
//
// A manifest an agent writes carries holes (`{{namespace}}`, `{{image}}`) that the PLATFORM fills
// at provision time from the workspace's engine connection, and this suite configures both ends:
// `k3s.ts` registers the connection, `instructions.ts` tells the agent which placeholders to emit
// verbatim. So a template that renders to nothing usable is not a cluster problem and not a model
// problem, it is a configuration problem, and it surfaces an hour later wearing the face of one of
// the other two. Both checks here exist to move that hour to the front of the pass.
//
// **They read the CONFIG and nothing else**, which is why they are a separate module from
// `prerequisites.ts` rather than two more entries in it: nothing here opens a connection, so
// nothing here needs the client, the deployment, the ledger or the board. The narrower context is
// stated in the type, and it keeps the file that holds the deployment-facing checks from growing
// a third concern.
//
// The shared shape of a refusal here: name the variable AND its rendered value, because a template
// is unreadable until you see what it produced, and offer the default as the fix, because for both
// of these the default is a working answer.

import type { AcceptanceConfig } from './config.ts'
import { renderEnvironmentHost, renderEnvironmentImage } from './k3s.ts'
import { envAssignment } from './operatorText.ts'
import { type Prerequisite, satisfied, unsatisfied } from './preflight.ts'

const K3S_DOC = 'backend/docs/local-k3s-environments.md'

const DEFAULT_INGRESS_HOST_TEMPLATE = '{{namespace}}.127.0.0.1.nip.io'
const DEFAULT_IMAGE_TEMPLATE = 'ghcr.io/{{repoOwner}}/{{repoName}}:pr-{{pullNumber}}'

/**
 * All these two checks need. Narrower than `PreflightContext` on purpose, and assignable from it,
 * so the runner still drives them from the one context it builds.
 */
export type ManifestTemplateContext = { config: AcceptanceConfig }

export const MANIFEST_TEMPLATE_PREREQUISITES: readonly Prerequisite<ManifestTemplateContext>[] = [
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
                    DEFAULT_INGRESS_HOST_TEMPLATE,
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
    id: 'image-template',
    what: "the manifests' {{image}} placeholder resolves to an image reference a cluster can pull",
    disposition: 'required',
    check: async ({ config }) => {
      // The failure this exists for, in full, because it is the one that cost an afternoon and it
      // is invisible from either end alone. The scaffold briefs make `{{image}}` mandatory in every
      // Deployment; the platform substitutes it from the CONNECTION's `imageTemplate`; and
      // `renderTemplate` renders a hole it cannot fill as the empty string rather than refusing.
      // A pass therefore ran an architect, a coder and a reviewer, opened a pull request, and died
      // at the deployer with `Deployment.apps "catalog-api" is invalid:
      // spec.template.spec.containers[0].image: Required value` — an apiserver complaining about a
      // field the manifest sets perfectly well.
      const template = config.cluster.imageTemplate
      const verdict = renderEnvironmentImage(template, {
        repoOwner: config.repoOwner,
        repoName: config.repos.backend,
        // A pull request this suite has not opened yet, and the platform's own branch shape: the
        // slash is what makes `{{branch}}` unusable as a tag, so the sample has to carry one.
        pullNumber: '1',
        branch: 'cat-factory/task_19312e8862264172b1fa1051',
        namespace: 'cf-acc-1',
      })
      if (verdict.ok) {
        // States what it did NOT check, in the same breath as the pass. Both omissions are
        // reachable states of a correctly configured suite (nothing has published a first image
        // yet; a fresh GHCR package is private until someone says otherwise), and both present as
        // an environment that provisions and never becomes ready, which reads like a cluster fault.
        return satisfied(
          `'${template}' renders as '${verdict.rendered}'. Whether anything PUBLISHES that ` +
            `reference, and whether the cluster may pull it, is not readable from here: a private ` +
            `registry package answers 403 to the kubelet and the environment then never becomes ready`,
        )
      }
      return unsatisfied(`ACCEPTANCE_K3S_IMAGE_TEMPLATE ('${template}') ${verdict.problem}`, {
        steps: [
          'Build the reference from what a per-PR provision knows: {{repoOwner}}, {{repoName}}, ' +
            '{{pullNumber}}, {{branch}} and {{namespace}}. There is no commit sha among them, and ' +
            'a tag may not contain the slash {{branch}} renders.',
          'The briefs ask each scaffold for a workflow that publishes exactly this reference, so ' +
            'changing it changes what the agent is asked to push; the two are threaded from this ' +
            'one variable and cannot be set apart.',
          'Unsetting the variable is also a fix, since the default below is what it falls back to.',
        ],
        commands: [
          {
            run: envAssignment('ACCEPTANCE_K3S_IMAGE_TEMPLATE', DEFAULT_IMAGE_TEMPLATE),
            purpose: "use the documented default, which the scaffolds' own workflow publishes",
          },
        ],
        docs: K3S_DOC,
      })
    },
  },
]
