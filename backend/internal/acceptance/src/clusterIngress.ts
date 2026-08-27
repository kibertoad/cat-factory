// Whether the configured cluster can SERVE the environment URL a pass's testers read, asked before
// a pass spends anything.
//
// **Why this is its own check and not part of `cluster-connection`.** That one proves the apiserver
// answers the ServiceAccount token, which is what a `deployer` step needs to CREATE things. Serving
// an ingress-derived URL takes two more facts that no apiserver credential implies: an ingress
// CONTROLLER in the cluster, and a HOST PORT published into it. Both were assumed, and the pass that
// motivated this file is what assuming them costs. Its cluster had neither: `k3d-cat-factory-serverlb`
// forwarded only `6443`, and `kubectl get ingressclass` returned an empty list. Four agents ran, a
// pull request opened, a namespace came up with a healthy pod, the platform published
// `http://cf-acc-pr8.127.0.0.1.nip.io` and called it ready, and the `tester-api` step spent fourteen
// minutes on curl code 000 before failing the run at forty-three minutes. Every one of those minutes
// was spent on a question this check answers in about two seconds.
//
// **It asks about the CLUSTER, never about reachability from here.** That distinction is why the
// probe is admissible at all: PR #2075 rejected a post-provision reachability probe because preflight
// runs on the host while agents run in containers, so a host-side `curl` would pass exactly where a
// containerized tester fails, and a false pass is worse than no check. The two facts read here are
// facts about the cluster's own configuration (its `IngressClass` list, and what its container
// forwards), so neither can be true here and false in a container.
//
// **What it deliberately will not claim.** The `IngressClass` read goes through the CURRENT kubectl
// context, which this suite has no way to tie to the apiserver URL it was configured with. So the
// check runs only when the configured apiserver names this machine, and reports `unknown` rather
// than a verdict otherwise: grading a remote cluster by reading whatever context happens to be
// selected would be a confident answer about the wrong cluster.

import { type Prerequisite, satisfied, unknown, unsatisfied } from '@cat-factory/acceptance-kit'
import {
  createNodeShell,
  createNodeTcpProbe,
  DEFAULT_INGRESS_PORT,
  ingressRemedies,
  isLocalMachineHost,
  OPTION_DEFAULTS,
  probeIngress,
} from '@cat-factory/cli'
import type { AcceptanceConfig } from './config.ts'
import { K3S_DOC } from './config.ts'

/** All this check needs, and assignable from `PreflightContext` so the one runner drives it. */
export type ClusterIngressContext = { config: AcceptanceConfig }

/**
 * The port the derived environment URL is served on.
 *
 * The suite configures a portless HOST template (a Kubernetes Ingress `host` may not carry a port),
 * so the port is the ingress controller's published default rather than something read off the
 * config. An operator serving their cluster on a non-default host port has an environment URL this
 * suite does not construct, which is why this is a constant here and a field on the CLI's own probe.
 */
const SERVED_PORT = DEFAULT_INGRESS_PORT

/** The hostname half of the configured apiserver URL, or null when it is not a URL at all. */
function apiServerHost(apiServerUrl: string): string | null {
  try {
    return new URL(apiServerUrl).hostname
  } catch {
    return null
  }
}

export const CLUSTER_INGRESS_PREREQUISITES: readonly Prerequisite<ClusterIngressContext>[] = [
  {
    id: 'cluster-ingress',
    what: 'the cluster runs an ingress controller and publishes a host port into it',
    disposition: 'required',
    check: async ({ config }) => {
      const host = apiServerHost(config.cluster.apiServerUrl)
      // Not this machine's cluster ⇒ say so and grade nothing. `unknown` rather than `advisory`
      // because the condition is still REQUIRED for a pass to work; what is missing is a way to
      // read it from here, and those are different facts (see the header).
      if (!host || !isLocalMachineHost(host)) {
        return unknown(
          `${config.cluster.apiServerUrl} does not name this machine, so this check cannot tell ` +
            `whether the cluster it points at runs an ingress controller: the IngressClass read ` +
            `goes through the current kubectl context, which nothing ties to that URL.`,
          {
            steps: [
              'Confirm by hand that the cluster serves an ingress-derived host, then re-run. The ' +
                'two questions are whether it runs an ingress controller and whether requests on ' +
                `port ${SERVED_PORT} reach it.`,
              'The platform now refuses a provision whose Ingress no controller can claim, so a ' +
                'missing controller fails at the `deployer` step with the cause named rather than ' +
                'at the tester fourteen minutes later. This check only moves that answer earlier.',
            ],
            commands: [
              {
                run: 'kubectl get ingressclass',
                purpose:
                  'list the ingress classes the cluster publishes (an empty list is the finding)',
              },
            ],
            docs: K3S_DOC,
          },
        )
      }

      // `waitMs: 0`: a pass runs against a cluster the operator already has, so there is no
      // freshly-created controller to wait for. The CLI's own setup path is what passes a budget.
      // No `cluster` is supplied either — this suite is configured with an apiserver URL and not a
      // k3d/kind cluster name, so an answering port grades as `unattributed` rather than claiming
      // the stronger fact that it belongs to this cluster.
      const readiness = await probeIngress(
        { shell: createNodeShell(), tcp: createNodeTcpProbe() },
        { port: SERVED_PORT, waitMs: 0 },
      )

      if (readiness.status === 'ready') {
        const attributed =
          readiness.attribution === 'cluster'
            ? 'confirmed as this cluster'
            : 'answering, though nothing confirmed the listener belongs to this cluster'
        return satisfied(
          `the '${readiness.controller}' ingress controller is installed and host port ` +
            `${readiness.port} is ${attributed}`,
        )
      }

      // The CLI owns the remedy STEPS, keyed off the same verdict it built. Restating them here is
      // how the two would drift, and they are the one place a reader is told which HALF is missing:
      // installing a controller and publishing a port are different fixes, and the port one is
      // create-time-only on k3d/kind, so it needs the cluster rebuilt rather than reconfigured.
      //
      // Called with NO context, which is the honest call rather than a lazy one. This suite is
      // configured with an apiserver URL, so it knows neither the distribution nor the cluster's
      // name, and `ingressRemedies` documents that an absent `recreateCommand` prints no recreate
      // line precisely so a caller in this position does not emit one the CLI would then refuse.
      // The commands below name the CLI's DEFAULTS and say so, which is a different claim.
      const cluster = OPTION_DEFAULTS.k3sClusterName
      const remedy = {
        steps: ingressRemedies(readiness),
        commands: [
          {
            run: 'kubectl get ingressclass',
            purpose:
              'list the ingress classes the cluster publishes (an empty list is the finding)',
          },
          {
            run: `docker port k3d-${cluster}-serverlb`,
            purpose:
              `check whether the cluster forwards a host port into its controller ` +
              `(${SERVED_PORT}/tcp); assumes the default cluster name '${cluster}', so substitute ` +
              `yours if you named it something else`,
          },
          {
            run: 'npx @cat-factory/cli k3s --recreate',
            purpose:
              'rebuild the cluster with the ingress host port published (it cannot be added to a ' +
              'running k3d/kind cluster) and re-grant the ServiceAccount RBAC, which now includes ' +
              'the ingressclasses read the platform grades a provision against',
          },
        ],
        docs: K3S_DOC,
      }

      if (readiness.status === 'unknown') {
        return unknown(
          `could not establish whether this cluster can serve an ingress-derived URL ` +
            `(${readiness.cause}): ${readiness.probeFailure}`,
          remedy,
        )
      }

      const published =
        readiness.publishedOn === undefined
          ? ''
          : ` The cluster does publish host port ${readiness.publishedOn}, so the environment URL ` +
            `would need that port rather than ${readiness.port}.`
      return unsatisfied(
        `this cluster cannot serve the environment URL a tester reads: ` +
          `${readiness.gaps.join(' and ')} missing on host port ${readiness.port}. A pass would ` +
          `still deploy and report healthy pods, and every tester step would then fail on a URL ` +
          `that answers nothing.${published}`,
        remedy,
      )
    },
  },
]
