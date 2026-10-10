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
//
// **A template is graded as it will be COMPOSED, never on its own.** The ingress check reads the
// namespace template too, and renders one through the other, because the failure that motivated
// this rule lived in neither half: both rendered cleanly and the name they built resolved to
// another network entirely. A check that grades one variable at a time cannot see that class of
// fault at all, and it is the class that costs the most, because everything upstream of the
// tester succeeds.

import {
  envAssignment,
  type Prerequisite,
  type PrerequisiteVerdict,
  satisfied,
  unsatisfied,
} from '@cat-factory/acceptance-kit'
import {
  describeWildcardDnsShift,
  describeWildcardDnsShiftProblem,
  wildcardDnsShiftRemedies,
} from '@cat-factory/contracts'
import type { AcceptanceConfig } from './config.ts'
import {
  DEFAULT_IMAGE_TEMPLATE,
  DEFAULT_INGRESS_HOST_TEMPLATE,
  DEFAULT_NAMESPACE_TEMPLATE,
  K3S_DOC,
} from './config.ts'
import {
  imageTemplateSample,
  renderEnvironmentHost,
  renderEnvironmentImage,
  renderEnvironmentNamespace,
} from './k3s.ts'

/**
 * All these two checks need. Narrower than `PreflightContext` on purpose, and assignable from it,
 * so the runner still drives them from the one context it builds.
 */
export type ManifestTemplateContext = { config: AcceptanceConfig }

export const MANIFEST_TEMPLATE_PREREQUISITES: readonly Prerequisite<ManifestTemplateContext>[] = [
  {
    id: 'ingress-template',
    what: 'the configured namespace and host templates compose into a URL that reaches this cluster',
    disposition: 'required',
    check: async ({ config }) => {
      // Rendered against a sample pull request: the real one carries a number no run has produced
      // yet. What it proves is that the templates hold no hole the platform cannot fill, the
      // failure that otherwise appears as an environment stuck `provisioning` behind a URL nobody
      // can resolve.
      //
      // **Graded once PER REPOSITORY**, because a namespace template may name `{{repoName}}` and
      // a pass provisions from both. Grading the backend's alone passed a configuration whose
      // FRONTEND namespace shifted (`catalog-api` carries no window, `catalog-2` composes
      // `2.127.0.0`), and the cost of that miss is the whole point of a preflight: everything
      // upstream of the frontend's tester succeeds first.
      const compositions = []
      for (const repo of [config.repos.backend, config.repos.frontend]) {
        const composed = composeEnvironmentUrlHost(config, repo)
        if ('problem' in composed) return composed.problem
        compositions.push(composed)
      }
      // Names the compositions rather than the templates, because the composition is the thing
      // nobody has seen written down and the thing that was wrong.
      return satisfied(
        compositions
          .map(({ repo, namespace, host }) => `${repo} provisions '${namespace}' at '${host}'`)
          .join('; '),
      )
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
      // The sample's KEY SET is `k3s.ts`'s, beside the renderer that judges against it: it has to
      // be what the deployer supplies, and `{{namespace}}` is NOT among them however much the
      // manifests' own use of that hole suggests otherwise (the image is rendered one step before
      // the namespace joins the vars).
      const verdict = renderEnvironmentImage(
        template,
        imageTemplateSample({ owner: config.repoOwner, name: config.repos.backend }),
      )
      if (verdict.ok) {
        // States what it did NOT check, in the same breath as the pass. Each omission is a
        // reachable state of a correctly configured suite, and each presents as an environment
        // that provisions and never becomes ready, which reads like a cluster fault.
        //
        // The PULL half used to be listed here as unfixable. It no longer is: against an
        // apiserver on this machine the platform now wires the workspace's own git credential
        // into each per-PR namespace as a registry pull secret, so a private GHCR package pulls
        // with no setup. What
        // remains unreadable from here is whether THAT credential carries package-read scope,
        // because it is the deployment's sealed VCS connection and no `/api/v1` operation
        // publishes a token's scopes. A pass names it so the 403 has somewhere to point.
        return satisfied(
          `'${template}' renders as '${verdict.rendered}'. Three things are not readable from ` +
            `here: whether anything PUBLISHES that reference (the workflow the briefs ask for ` +
            `first runs when the pull request opens), whether the workspace's VCS credential may ` +
            `PULL it (the platform wires that credential into each per-PR namespace on a local ` +
            `cluster, so a private package needs no setup, but a token without package-read ` +
            `scope still earns a 403: see the README), and whether the owner is spelled as the ` +
            `provider spells it (the platform fills {{repoOwner}} from the pull request URL)`,
        )
      }
      return unsatisfied(`ACCEPTANCE_K3S_IMAGE_TEMPLATE ('${template}') ${verdict.problem}`, {
        steps: [
          'Build the reference from what a per-PR provision knows: {{repoOwner}}, {{repoName}}, ' +
            '{{pullNumber}}, {{pullUrl}}, {{branch}} and {{blockId}}. There is no commit sha ' +
            'among them, a tag may not contain the slash {{branch}} renders, and {{namespace}} is ' +
            'not one of them: the platform renders the image BEFORE the namespace exists, so a ' +
            'template naming it produces exactly the empty image this check exists to prevent.',
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

/** One repository's rendered namespace and the environment URL host it composes. */
type ComposedEnvironmentUrl = { repo: string; namespace: string; host: string }

/**
 * Render the two templates as a provision of `repo` would, or hand back the refusal.
 *
 * The three failures are kept apart because they are three different edits: a namespace template
 * holding a hole nothing fills, a host template holding one, and two templates that each render
 * perfectly and compose into a name pointing at another network. Only the third needed inventing;
 * it is also the only one nothing downstream can catch.
 */
function composeEnvironmentUrlHost(
  config: AcceptanceConfig,
  repo: string,
): ComposedEnvironmentUrl | { problem: PrerequisiteVerdict } {
  const sample = imageTemplateSample({ owner: config.repoOwner, name: repo })
  const namespace = renderEnvironmentNamespace(config.cluster.namespaceTemplate, sample)
  if (namespace === null) {
    // The vocabulary is READ OFF the sample rather than restated, because the sample's key set is
    // what the renderer actually fills from. A hand-written list here was already short of six of
    // them, which is a working template refused with a message naming the wrong words.
    const fillable = Object.keys(sample)
      .map((key) => `{{${key}}}`)
      .join(', ')
    return {
      problem: unsatisfied(
        `ACCEPTANCE_K3S_NAMESPACE_TEMPLATE ('${config.cluster.namespaceTemplate}') still holds ` +
          `an unrendered placeholder after ${repo}'s pull-request values are substituted`,
        {
          steps: [
            `Build the template from the values a per-PR provision knows: ${fillable}. It may ` +
              'not name {{namespace}}, which is what this template PRODUCES.',
            'Unsetting the variable is also a fix, since the default below is the fallback.',
          ],
          commands: [
            {
              run: envAssignment('ACCEPTANCE_K3S_NAMESPACE_TEMPLATE', DEFAULT_NAMESPACE_TEMPLATE),
              purpose: 'use the documented default, which renders per pull request',
            },
          ],
          docs: K3S_DOC,
        },
      ),
    }
  }
  const host = renderEnvironmentHost(config.cluster.ingressHostTemplate, namespace)
  if (host === null) {
    return {
      problem: unsatisfied(
        `ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE ('${config.cluster.ingressHostTemplate}') still ` +
          `holds an unrendered placeholder after {{namespace}} is substituted`,
        {
          steps: [
            'Build the template from {{namespace}} only: it is the one value known before a ' +
              'run opens its pull request, so {{branch}} and {{pullNumber}} leave a hole the ' +
              'suite cannot fill.',
            'The default below needs no DNS of your own, because nip.io answers from the ' +
              'address written into the name.',
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
      ),
    }
  }
  // The check this file was missing, and the reason a pass once spent four agents and a pull
  // request before failing: BOTH templates rendered perfectly, and the name they composed pointed
  // at a different network. A wildcard-DNS host carries its address in the name, so a namespace
  // ending in a separator plus digits contributes an address of its own and, being further left,
  // wins. Nothing downstream can catch it: the workloads are healthy, the environment reports
  // `ready`, and the first thing to notice is the tester, eight minutes and one confusing
  // connection error later.
  const shift = describeWildcardDnsShift(host)
  if (!shift) return { repo, namespace, host }
  return {
    problem: unsatisfied(
      `ACCEPTANCE_K3S_NAMESPACE_TEMPLATE and ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE compose into a ` +
        `URL that does not reach this cluster for ${repo}: ` +
        describeWildcardDnsShiftProblem(shift),
      {
        steps: [
          ...wildcardDnsShiftRemedies(shift),
          'Unsetting BOTH variables is also a fix: the defaults below are chosen to compose.',
        ],
        commands: [
          {
            run: envAssignment('ACCEPTANCE_K3S_NAMESPACE_TEMPLATE', DEFAULT_NAMESPACE_TEMPLATE),
            purpose:
              `renders a namespace ending in a letter, so '${shift.trailing}' is the ` +
              `only address in the name`,
          },
        ],
        docs: K3S_DOC,
      },
    ),
  }
}
