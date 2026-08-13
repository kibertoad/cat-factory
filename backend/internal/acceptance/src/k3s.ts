// The k3s ephemeral-environment wiring: the two halves the platform keeps deliberately apart.
//
// cat-factory splits a per-PR environment into an ENGINE (the workspace's infra handler: which
// apiserver, which credentials, how a URL is derived) and a SOURCE (each service's own
// `provisioning`: where its manifests live). See `backend/docs/per-service-provisioning.md`. The
// suite has to supply both, and they are built here rather than inline in a scenario so the pair
// stays readable as a pair.
//
// **Two values here are also written into the BRIEFS** (`instructions.ts`): the ingress host
// template and the image template. Both are holes the platform fills at provision time, so the
// manifests an agent writes and the connection this suite registers have to agree about them or
// the environment is applied as something nobody wrote. They are threaded from this one place for
// that reason, and each has a prerequisite that renders it before a pass spends anything.
//
// **`raw`, not `kustomize`, is load-bearing.** A `raw` manifest source is applied synchronously
// over the apiserver REST client the backend already speaks, so this suite needs no deploy
// runner at all. A `kustomize` overlay must be rendered by the container-backed deploy adapter,
// which would add `LOCAL_DEPLOY_RUNTIME=container` plus a pullable deploy image to the setup:
// real product surface, but a second thing to get wrong before the first assertion runs. The
// suite covers the leaner path and says so; `backend/docs/local-k3s-environments.md` owns the
// other one.

import type { PublicEnvironmentConnection, PublicServiceProvisioning } from '@cat-factory/contracts'
import type { ClusterConfig } from './config.ts'

/**
 * The in-repo directory the bootstrapped services put their manifests in.
 *
 * It appears in exactly two places (here, and in the bootstrap instructions that ask the agent
 * to author them, `instructions.ts`), and they must agree, because the failure mode when they
 * do not is a `deployer` step reporting an empty manifest source, which reads like a broken
 * cluster rather than a mismatched path. Both read this constant.
 */
export const MANIFEST_DIR = 'deploy/k8s'

/**
 * The two configured templates a scaffold brief has to state, so it asks for manifests the engine
 * this suite registers can actually render. Threaded rather than re-read, so the pair travels
 * together: a brief holding one of them and a literal for the other is the drift they exist to
 * prevent.
 */
export type ManifestTargets = Pick<ClusterConfig, 'ingressHostTemplate' | 'imageTemplate'>

/** The secret-bundle key the Kubernetes env backend reads its ServiceAccount token from. */
const TOKEN_SECRET_KEY = 'apiToken'

/**
 * The workspace-level engine connection.
 *
 * `insecureSkipTlsVerify` is offered because k3s self-signs and a throwaway local cluster is
 * exactly the case the field documents itself for; a CA PEM is preferred and wins when both are
 * supplied, so an operator who pasted one is never silently downgraded.
 *
 * The public engine is `kubernetes`, singular. The platform's INTERNAL vocabulary splits it in two
 * (`local-k3s` and `remote-kubernetes`), and the public surface deliberately does not: one backend
 * serves both and they lower to the same provision config, so the choice was never observable in
 * anything a run does. A k3d cluster reached over loopback is described here exactly as any other
 * cluster would be.
 */
export function buildK3sConnection(cluster: ClusterConfig): PublicEnvironmentConnection {
  return {
    engine: 'kubernetes',
    kubernetes: {
      label: 'Acceptance k3s',
      apiServerUrl: cluster.apiServerUrl,
      // What `{{image}}` in the manifests resolves to, and NOT optional in practice: the briefs
      // require every Deployment to name that placeholder, and the platform renders an unknown
      // hole as the empty string, so a connection without this ships `image: ""` to the apiserver.
      // That is a real pass, lost at the deployer step after two agents had already run:
      // `Deployment.apps "catalog-api" is invalid: spec.template.spec.containers[0].image:
      // Required value`. The `image-template` prerequisite is what refuses BEFORE the spend.
      imageTemplate: cluster.imageTemplate,
      ...(cluster.caCertPem
        ? { caCertPem: cluster.caCertPem }
        : { insecureSkipTlsVerify: cluster.insecureSkipTlsVerify }),
      namespaceTemplate: cluster.namespaceTemplate,
      url: { source: 'ingressTemplate', hostTemplate: cluster.ingressHostTemplate, scheme: 'http' },
      // 45 minutes. The sweeper's backstop only, not the normal exit: the `disposer` step
      // reclaims the namespace as the run settles, and scenario 02 asserts it did. A TTL that fired
      // first would tear the environment down under the assertion and report a teardown the run
      // did not perform.
      defaultTtlMs: 45 * 60 * 1000,
      labels: { 'cat-factory.ai/acceptance': 'true' },
    },
  }
}

/** The secret bundle that rides the handler registration. Never logged; never echoed back. */
export function buildK3sSecrets(cluster: ClusterConfig): Record<string, string> {
  return { [TOKEN_SECRET_KEY]: cluster.apiToken }
}

/** The per-service half: manifests colocated in the service's own repo, read at the PR head. */
export function buildServiceProvisioning(): PublicServiceProvisioning {
  return {
    type: 'kubernetes',
    manifestSource: { type: 'colocated', path: MANIFEST_DIR, renderer: 'raw' },
  }
}

/**
 * The environment URL a namespace will answer on, for a scenario that wants to state the expectation
 * before the run produces it.
 *
 * Renders the same `{{namespace}}` hole the backend renders, and ONLY that one: the other
 * provision vars (`{{branch}}`, `{{pullNumber}}`) are not known to this suite before a run opens
 * its pull request, so a template using them is reported as unrenderable rather than guessed at.
 */
export function renderEnvironmentHost(hostTemplate: string, namespace: string): string | null {
  const rendered = hostTemplate.replaceAll('{{namespace}}', namespace)
  return rendered.includes('{{') ? null : rendered
}

/** The per-pull-request values the platform fills an image template's holes with. */
export type ImageTemplateSample = {
  repoOwner: string
  repoName: string
  pullNumber: string
  branch: string
  namespace: string
}

/** Whether a template yields an image reference a cluster could actually pull. */
export type ImageTemplateVerdict = { ok: true; rendered: string } | { ok: false; problem: string }

/**
 * Render an image template against a sample pull request and say whether the result is usable.
 *
 * The sibling of {@link renderEnvironmentHost}, and for the same reason: the value is configured
 * here and embedded in the briefs, so a hole the platform cannot fill is a manifest that applies
 * as something nobody wrote. It renders an unknown key to '' exactly as the platform does
 * (`kubernetes-environment.logic.ts`), and then NAMES the key, because that substitution is
 * silent on the other side and its symptom is an apiserver error about a field the manifest sets.
 *
 * It is not a reference parser and does not try to be. It checks the three things that are wrong
 * ABOUT A TEMPLATE rather than about an image: a hole nothing fills, a name the registry will
 * reject on case, and a tag built from something that is not tag-shaped. Everything else is a fact
 * about the registry, which reports it honestly at pull time.
 */
export function renderEnvironmentImage(
  template: string,
  sample: ImageTemplateSample,
): ImageTemplateVerdict {
  const unfilled = new Set<string>()
  const fill = (part: string): string =>
    part.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key: string) => {
      const value = (sample as Record<string, string>)[key]
      if (value === undefined) unfilled.add(key)
      return value ?? ''
    })

  // The tag boundary is read off the TEMPLATE rather than off the rendered string, and that is
  // load-bearing rather than tidy: a placeholder can hold neither ':' nor '/' (the hole syntax is
  // alphanumeric), so the template's own structure survives rendering, while the rendered string's
  // does not. `{{branch}}` renders a slash INTO the tag, which moves the last slash past the last
  // colon and makes a reference with a broken tag read as one with no tag at all: the least useful
  // of the available messages, and the one the trap would always produce.
  const lastSlash = template.lastIndexOf('/')
  const lastColon = template.lastIndexOf(':')
  const tagged = lastColon > lastSlash
  const name = fill(tagged ? template.slice(0, lastColon) : template).trim()
  const tag = tagged ? fill(template.slice(lastColon + 1)).trim() : null
  const rendered = tag === null ? name : `${name}:${tag}`

  if (unfilled.size > 0) {
    return {
      ok: false,
      problem:
        `names ${[...unfilled].map((key) => `{{${key}}}`).join(', ')}, which a per-PR provision ` +
        `does not fill (it knows ${Object.keys(sample).join(', ')}), and the platform renders an ` +
        `unfilled hole as nothing`,
    }
  }
  if (name === '') return { ok: false, problem: 'renders to nothing' }
  if (tag === null) {
    return {
      ok: false,
      problem:
        `renders as '${rendered}', which carries no tag, so every pull request would pull the ` +
        `same ':latest' and an environment could never be the code under review`,
    }
  }
  if (/[A-Z]/.test(name)) {
    return {
      ok: false,
      problem:
        `renders as '${rendered}', whose name is not lowercase; registries reject that. ` +
        `ACCEPTANCE_REPO_OWNER is the usual source, since {{repoOwner}} is copied verbatim`,
    }
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
    return {
      ok: false,
      problem:
        `renders as '${rendered}', whose tag '${tag}' is not a legal tag` +
        // Stated rather than left to the charset, because it is the specific trap: `{{branch}}`
        // looks like the obvious per-PR discriminator and the platform's own branches are
        // `cat-factory/<taskId>`, so it renders a tag with a slash in it every single time.
        (tag.includes('/')
          ? ` (a tag may not contain '/', which is what {{branch}} renders here: the platform ` +
            `pushes to 'cat-factory/<taskId>')`
          : ''),
    }
  }
  return { ok: true, rendered }
}

/**
 * The FIXED tail of an ingress host template: everything after the last `}}`.
 *
 * What a scenario can honestly assert about a provisioned environment's URL. The namespace and
 * pull-request number in the template are values the RUN chose, which this suite cannot predict
 * and has no business pinning; the domain it configured is the part that proves the URL came from
 * the k3s wiring under test rather than from some other environment backend.
 */
export function hostSuffix(hostTemplate: string): string {
  const lastHole = hostTemplate.lastIndexOf('}}')
  return lastHole === -1 ? hostTemplate : hostTemplate.slice(lastHole + 2)
}
