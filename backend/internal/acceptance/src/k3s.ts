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

/**
 * The per-service half: manifests colocated in the service's own repo, read at the PR head.
 *
 * Typed as the KUBERNETES member rather than the whole union, because that is what it builds and a
 * caller reads `manifestSource` straight off it. The public union gained a `custom` member for
 * deployments that ship their own environment backend; this suite runs against k3s.
 */
export function buildServiceProvisioning(): Extract<
  PublicServiceProvisioning,
  { type: 'kubernetes' }
> {
  return {
    type: 'kubernetes',
    manifestSource: { type: 'colocated', path: MANIFEST_DIR, renderer: 'raw' },
  }
}

/**
 * The placeholder syntax, which is the PLATFORM's and not this suite's to choose.
 *
 * Byte for byte `renderTemplate`'s in `kubernetes-environment.logic.ts`, including the `\s*` either
 * side of the key: `{{ namespace }}` is a hole the platform fills, so a gate here that reads only
 * `{{namespace}}` refuses a template that would have worked, before the pass starts, in the name of
 * rendering exactly as the platform does. The two renderers below share it for the same reason they
 * exist at all, which is that a second spelling of this rule is a second thing to drift.
 *
 * Safe as one shared `/g` value because both uses are `String.replace`, which resets `lastIndex`.
 * A `.test()` against it would not be.
 */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

/**
 * The environment URL a namespace will answer on, for a scenario that wants to state the expectation
 * before the run produces it.
 *
 * Renders the same `{{namespace}}` hole the backend renders, and ONLY that one: the other
 * provision vars (`{{branch}}`, `{{pullNumber}}`) are not known to this suite before a run opens
 * its pull request, so a template using them is reported as unrenderable rather than guessed at.
 *
 * An unfilled hole is left VERBATIM rather than emptied, so the brace check below catches it. That
 * is what makes "this suite cannot render it" and "the platform would render it to nothing" the same
 * answer here, where the image sibling has to tell them apart because only it grades a REFERENCE.
 */
export function renderEnvironmentHost(hostTemplate: string, namespace: string): string | null {
  const rendered = hostTemplate.replace(PLACEHOLDER, (hole, key: string) =>
    key === 'namespace' ? namespace : hole,
  )
  return rendered.includes('{{') || rendered.includes('}}') ? null : rendered
}

/**
 * The namespace a pull request will be provisioned into, for composing with the host template.
 *
 * Exists because the two are only wrong TOGETHER: a namespace is a fine namespace whatever it
 * ends in, and a host template is fine whatever it is prefixed with, and the environment is
 * unreachable when one particular pair meets (see `describeWildcardDnsShift` in contracts). So
 * the `ingress-template` prerequisite renders this and feeds it to {@link renderEnvironmentHost}
 * rather than grading either half on its own.
 *
 * Rendered against the same sample as the image template, because the namespace template draws
 * on the same per-PR vars. Lowercased because the platform sanitizes to an RFC1123 label, and
 * NOT otherwise sanitized: `k8sName` lives in `@cat-factory/integrations`, which this suite does
 * not depend on, and a second copy of that rule here would be a thing to drift. The cost is
 * bounded and worth naming: a template whose sanitized form differs in a way that MATTERS here
 * (an underscore, which `k8sName` turns into the `-` that opens an octet) is graded as its
 * unsanitized self and can still slip past. The platform refuses it at provision either way;
 * this check exists to move the common case in front of the spend, not to be the only guard.
 */
export function renderEnvironmentNamespace(
  namespaceTemplate: string,
  sample: ImageTemplateSample,
): string | null {
  const rendered = namespaceTemplate
    .replace(PLACEHOLDER, (hole, key: string) =>
      Object.hasOwn(sample, key) ? sample[key as ImageTemplateKey] : hole,
    )
    .toLowerCase()
  return rendered.includes('{{') || rendered.includes('}}') ? null : rendered
}

/**
 * The per-pull-request values the platform fills an image template's holes with.
 *
 * **The KEY SET is the load-bearing half**, not the values: it decides which templates the gate
 * below refuses as unfillable, so it has to be exactly what the deployer supplies. That set is
 * assembled in two places on the other side. `DeployerStepController` passes the block's own
 * inputs (`blockId`, `title`, `type`, `description`) plus the frontend/peer URLs it derives, and
 * `EnvironmentProvisioningService` flattens the typed `ProvisionContext` (`branch`, `pullNumber`,
 * `pullUrl`, `repoOwner`, `repoName`) into the same namespace. A key missing from here is a
 * WORKING template refused with a message naming the wrong vocabulary; a key invented here is a
 * broken one waved through.
 *
 * **`namespace` is deliberately absent, and that is the trap this comment exists for.** It is a
 * hole in the INGRESS HOST template and in the manifests, which makes it look like a per-PR value
 * an image may be built from too. It is not: `KubernetesEnvironmentProvider.provisionContext`
 * renders `imageTemplate` against the bare inputs and only THEN adds `namespace` (and `image`) to
 * the vars the manifests are rendered with. So `…:{{namespace}}` renders here as a plausible tag
 * and on the platform as nothing at all, which is the `image: ""` refusal this whole gate exists
 * to move to the front of a pass.
 */
export type ImageTemplateSample = Record<ImageTemplateKey, string>

type ImageTemplateKey =
  | 'blockId'
  | 'title'
  | 'type'
  | 'description'
  | 'branch'
  | 'pullNumber'
  | 'pullUrl'
  | 'repoOwner'
  | 'repoName'
  | 'frontendOrigins'
  | 'peerEnvUrls'

/**
 * A sample provision of the named repository, for rendering a template before a pass opens
 * anything.
 *
 * Built here rather than at the call site so the key set travels with the renderer that judges
 * against it. The VALUES only have to be representative, and two of them are chosen rather than
 * arbitrary: `branch` carries the platform's own `cat-factory/<taskId>` shape, because the slash
 * is what makes `{{branch}}` unusable as a tag, and `title` carries a space, because a template
 * built from one renders a reference no registry accepts.
 *
 * `frontendOrigins` and `peerEnvUrls` are CONDITIONAL on the other side (a service no frontend
 * binds is provisioned without them). They are sampled as present anyway: a template naming one
 * is refused either way, and refusing it as "not a legal reference" is true where "a provision
 * does not fill it" would not be.
 *
 * Their VALUES carry `pr1` rather than `1`, and that is not cosmetic either: these are the
 * platform's own written examples of an environment URL, and `cf-acc-1.127.0.0.1.nip.io` is
 * precisely the name the `ingress-template` preflight now refuses (it answers 1.127.0.0). A
 * sample showing the shape the check rejects teaches the wrong thing to every operator and agent
 * that reads it.
 */
export function imageTemplateSample(repo: { owner: string; name: string }): ImageTemplateSample {
  return {
    blockId: 'blk_19312e8862264172b1fa1051',
    title: 'Stand up the catalog API service',
    type: 'feature',
    description: 'The catalog API',
    branch: 'cat-factory/task_19312e8862264172b1fa1051',
    pullNumber: '1',
    pullUrl: `https://github.com/${repo.owner}/${repo.name}/pull/1`,
    repoOwner: repo.owner,
    repoName: repo.name,
    frontendOrigins: 'http://cf-acc-pr1.127.0.0.1.nip.io',
    peerEnvUrls: 'catalog-web=http://cf-acc-pr1.127.0.0.1.nip.io',
  }
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
 * It is not a reference parser and does not try to be. It checks what is wrong ABOUT A TEMPLATE
 * rather than about an image: a hole nothing fills, a hole that is not even hole-SHAPED, a value
 * that renders whitespace into the reference, a name the registry will reject on case, and a tag
 * built from something that is not tag-shaped. Everything else is a fact about the registry, which
 * reports it honestly at pull time.
 */
export function renderEnvironmentImage(
  template: string,
  sample: ImageTemplateSample,
): ImageTemplateVerdict {
  const unfilled = new Set<string>()
  const fill = (part: string): string =>
    part.replace(PLACEHOLDER, (_match, key: string) => {
      // `Object.hasOwn`, never a nullish read: `{{toString}}` and `{{constructor}}` both match the
      // hole charset and both find a FUNCTION up the prototype chain, so an optional read reports
      // them as filled and splices `function toString() { [native code] }` into the reference.
      if (!Object.hasOwn(sample, key)) {
        unfilled.add(key)
        return ''
      }
      return sample[key as ImageTemplateKey]
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
  // NOT trimmed, deliberately: `renderTemplate` on the other side trims nothing, so a template
  // carrying a stray space renders one into the reference. Trimming here reported a value the
  // platform would never produce, and this gate's whole contract is to render as the platform does.
  const name = fill(tagged ? template.slice(0, lastColon) : template)
  const tag = tagged ? fill(template.slice(lastColon + 1)) : null
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
  // A leftover brace is a hole the SUBSTITUTION never saw: the syntax is `{{[a-zA-Z0-9_.]+}}`, so
  // `{{repo-owner}}`, `{{pull number}}` and a half-typed `{{pullNumber}` match nothing and survive
  // rendering verbatim, on this side and on the platform's. Without this they read as an ordinary
  // literal, and braces are not legal in a reference, so the manifest reaches the apiserver broken.
  // The sibling `renderEnvironmentHost` has always guarded this; the tag half here was only ever
  // covered by accident, through the tag charset, and the NAME half not at all.
  if (rendered.includes('{{') || rendered.includes('}}')) {
    return {
      ok: false,
      problem:
        `renders as '${rendered}', which still holds a brace: a placeholder is ` +
        `{{someName}} with no punctuation inside, so anything else is copied through as text`,
    }
  }
  if (name === '') return { ok: false, problem: 'renders to nothing' }
  if (/\s/.test(rendered)) {
    return {
      ok: false,
      problem:
        `renders as '${rendered}', which contains whitespace; no image reference may. Either the ` +
        `template holds a stray space (nothing trims one) or a hole it names renders prose`,
    }
  }
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
        `renders as '${rendered}', whose name is not lowercase; registries reject that` +
        // Named only when the template actually asks for the owner, because it is then the likely
        // source and the operator has a variable to edit. Said unconditionally it accused
        // ACCEPTANCE_REPO_OWNER of an uppercase letter that came from a hard-coded name or from
        // `{{title}}`. What it can NEVER promise is that a lowercase value here stays lowercase:
        // the platform re-derives `{{repoOwner}}` from the pull request URL, so what lands is the
        // provider's canonical spelling of the login, whatever this variable says.
        (template.includes('{{repoOwner}}')
          ? `. ACCEPTANCE_REPO_OWNER is the likely source, though the platform fills ` +
            `{{repoOwner}} from the pull request URL, so an owner whose canonical login carries ` +
            `a capital renders one however this variable is spelled`
          : ''),
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
