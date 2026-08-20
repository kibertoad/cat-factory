import type { PromptFragment } from '@cat-factory/contracts'

// Best-practice fragments for shipping a CONTAINERIZED SERVICE: building and publishing the
// image, the workload manifest that runs it, and the cross-file contract that wires the workload
// to traffic. Authored from a recurring class of review finding rather than from a topic list:
// five of seven findings on one design review came from this class, and every one of them is a
// rule that is invisible until the cluster refuses the pod (a `runAsNonRoot` container with a
// username instead of a numeric UID does not start; a `readOnlyRootFilesystem` container with no
// writable mount dies the first time something touches `/tmp`).
//
// Three concerns, one fragment each:
//   - `deployment.container-image`:   what goes into the image and what gates the push.
//   - `deployment.workload-runtime`:  the pod-level settings the cluster enforces at admission.
//   - `deployment.manifest-contract`: the names, labels and ports three files must agree on.
//
// Scoped by `appliesTo.agentKinds` rather than by block type: what makes these apply is that the
// step is DESIGNING or WRITING deployment artifacts, and a service, an API and a frontend all
// ship the same way. The design-time kinds get them because a round-2 finding here is usually a
// round-1 omission, which is the whole reason they are standards rather than review comments.

export const deploymentFragments: PromptFragment[] = [
  {
    id: 'deployment.container-image',
    version: '1.0.0',
    title: 'Container image build & publish',
    category: 'Deployment',
    summary:
      'Immutable digest-pinned tags, a push gated on lint/typecheck/test, non-root by construction, pull-side auth.',
    body: [
      'Container image standards:',
      '- Build for a NUMERIC non-root user: create the user in the image and set `USER <uid>` as a number, not a name. A workload with `runAsNonRoot` set cannot start from an image whose user is a name the kubelet cannot resolve to a uid.',
      '- Publish IMMUTABLE tags: a content digest, or a tag derived from the commit sha. Never re-push `latest` or a moving tag and never rely on one to roll out; the deployed revision must be identifiable from the manifest alone.',
      '- Gate the push on the checks: lint, typecheck and the test suite run BEFORE the image is published, not after. A published image is a thing someone can deploy, so an unverified one is a loaded gun in the registry.',
      '- Order the pipeline push-then-apply: the image must exist in the registry before any manifest referencing it is applied, or the rollout fails on `ImagePullBackOff` for a reason that has nothing to do with the manifest.',
      '- State the PULL-side auth: a registry is private by default (GHCR included), so the target namespace needs an image-pull credential and the workload must reference it. "The push worked" says nothing about whether the cluster can pull.',
      '- Keep the runtime image minimal: no build toolchain, no test fixtures, no secrets baked in as layers or build args. Secrets arrive at run time from the platform, never from the image.',
    ].join('\n'),
    brief:
      'Container image: `USER <numeric uid>` in the image (a username breaks `runAsNonRoot`); publish immutable digest/sha tags, never a moving `latest`; gate the push on lint+typecheck+test; push before applying any manifest that references the image; the target namespace needs a pull credential (private registry is the default, GHCR included); keep the runtime image minimal with no secrets baked in.',
    appliesTo: {
      agentKinds: ['architect', 'coder', 'spec-writer', 'deploy-fixer'],
    },
  },
  {
    id: 'deployment.workload-runtime',
    version: '1.0.0',
    title: 'Workload runtime hardening',
    category: 'Deployment',
    summary:
      'securityContext that actually starts, a writable mount for a read-only root, probes, resources, pull policy.',
    body: [
      'Workload runtime standards:',
      '- `runAsNonRoot: true` requires a NUMERIC `runAsUser` (and normally `runAsGroup` + `fsGroup`) on the pod or container securityContext. Without one the pod fails admission or the container fails to create; the image having a non-root user is not enough on its own.',
      '- `readOnlyRootFilesystem: true` requires an explicit writable mount for every path the process writes: at minimum an `emptyDir` at `/tmp`, plus caches, sockets and any scratch directory the runtime uses. Declare them; do not discover them from a crash loop.',
      '- Drop what is not needed: `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, and no host namespaces, host paths or privileged mode unless the workload genuinely cannot work without them, stated as such.',
      '- Set `imagePullPolicy` to match the tag: `IfNotPresent` is correct for an immutable digest-pinned tag and is a silent staleness bug for a mutable one. If the tag can move, the manifest is wrong, not the policy.',
      '- Declare BOTH resource requests and limits, and state the reasoning for the numbers rather than copying a template. Requests are what the scheduler places on; limits are what the kernel enforces. A missing request lands the pod anywhere; a missing memory limit leaves the node to absorb whatever it takes.',
      '- Declare readiness and liveness probes as the DIFFERENT questions they are: readiness gates traffic, liveness restarts the container. A liveness probe that checks a dependency turns an upstream outage into a restart loop.',
      '- Give the workload a real shutdown path: handle SIGTERM, stop accepting new work, drain in flight, and set `terminationGracePeriodSeconds` above the real drain time.',
    ].join('\n'),
    brief:
      'Workload runtime: `runAsNonRoot` needs a NUMERIC `runAsUser`/`runAsGroup` (the image alone is not enough); `readOnlyRootFilesystem` needs an explicit writable mount per written path (at minimum an `emptyDir` at `/tmp`); drop privileges (`allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, no host namespaces); `imagePullPolicy` must match tag mutability; declare resource requests AND limits with stated reasoning; readiness gates traffic and liveness restarts, so never probe a dependency in liveness; handle SIGTERM and size `terminationGracePeriodSeconds` to the real drain.',
    appliesTo: {
      agentKinds: ['architect', 'coder', 'deploy-fixer', 'environment-analyst'],
    },
  },
  {
    id: 'deployment.manifest-contract',
    version: '1.0.0',
    title: 'Manifest cross-file contract',
    category: 'Deployment',
    summary:
      'Selectors, labels, port names and namespaces that three files must agree on, from one source of truth.',
    body: [
      'Manifest cross-file contract:',
      'A workload, the Service in front of it and the Ingress routing to that Service are three files carrying ONE contract. Nothing validates it: every mismatch below applies cleanly and fails as a silent 404, a Service with no endpoints, or traffic reaching nothing.',
      '- The Service `selector` must match the pod TEMPLATE labels, not the labels on the workload object itself. These are different label sets and matching the wrong one is the single most common way to get a Service with zero endpoints.',
      '- The Ingress `backend.service.name` must be the Service `metadata.name`, and its `port` must name a port the Service actually exposes, by the same NAME the Service gave it where the Service names its ports.',
      '- Container `containerPort`, Service `targetPort` and the port the process actually listens on must be the same number. Prefer named ports so the agreement is readable rather than three literals to keep in step by hand.',
      '- Every object must land in the same namespace, stated explicitly. An object defaulting to `default` while its siblings are namespaced is a resource nothing can reach.',
      '- Derive the shared names and labels from ONE place (a chart value, a kustomize `commonLabels`, a single template variable). Three hand-written copies is not a contract, it is three chances to mistype one.',
      '- When you change any of these, change every file that names it in the SAME change, and say in your report which files the rename touched.',
    ].join('\n'),
    brief:
      'Manifest contract: the Service `selector` matches the POD TEMPLATE labels, not the labels on the workload object itself; the Ingress backend names the Service `metadata.name` and a port the Service exposes, by the NAME the Service gave it; `containerPort` / `targetPort` / the listening port are one number, preferably a named port; every object states the same namespace explicitly; derive shared names and labels from ONE source (chart value / `commonLabels`); rename across every file in one change and report which files it touched.',
    appliesTo: {
      agentKinds: ['architect', 'coder', 'deploy-fixer', 'environment-analyst'],
    },
  },
]

/**
 * The ids of the deployment fragments, in catalog order, derived from {@link deploymentFragments}
 * so it can never drift from the definitions. Exported for a deployment that wants the shipped
 * containerized-service set as the default for its own task type or preset, the way
 * `MIGRATION_FRAGMENT_IDS` serves `preset_tech_migration`.
 */
export const DEPLOYMENT_FRAGMENT_IDS: readonly string[] = deploymentFragments.map((f) => f.id)
