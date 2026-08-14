import { describe, expect, it } from 'vitest'
import { describeUnfilledConfigPlaceholders, unresolvedPlaceholders } from '@cat-factory/kernel'
import {
  environmentFailureReasonSchema,
  isRepoFixableEnvironmentFailure,
} from '@cat-factory/contracts'
import {
  classifyApplyFailure,
  classifyWorkloadFailure,
  KUBERNETES_CONFIG_PLACEHOLDERS,
} from './environment-failure.logic.js'

// The payload below is the real one from `exec_194b231198454c7785f29589`, not an invented
// example: a `pl_build` run whose deployer failed on a manifest that was CORRECT. It is the case
// the whole classification exists for, so it is asserted end to end here — the pre-apply refusal
// that should have caught it, and the guarantee that had it reached the apply, the resulting
// class would still have kept an automated fixer away from it.
const APISERVER_422_BODY = JSON.stringify({
  kind: 'Status',
  apiVersion: 'v1',
  metadata: {},
  status: 'Failure',
  message:
    'Deployment.apps "catalog-api" is invalid: spec.template.spec.containers[0].image: Required value',
  reason: 'Invalid',
  details: {
    name: 'catalog-api',
    group: 'apps',
    kind: 'Deployment',
    causes: [{ reason: 'FieldValueRequired', message: 'Required value', field: 'spec.template' }],
  },
  code: 422,
})

/** The manifest as the repository actually had it: templated, and correct. */
const CATALOG_API_MANIFEST = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: catalog-api
spec:
  template:
    spec:
      containers:
        - name: api
          image: "{{image}}"
`

describe('the exec_194b231198454c7785f29589 deployment failure', () => {
  it('is refused before the apply, naming the connection setting that was never filled in', () => {
    // The vars a provision builds when the workspace connection carries no `imageTemplate`:
    // `image` is simply absent, and `renderTemplate` would resolve it to ''.
    const vars = { blockId: 'task_19312e8862264172b1fa1051', namespace: 'cf-env-4' }
    const missing = unresolvedPlaceholders(
      CATALOG_API_MANIFEST,
      vars,
      KUBERNETES_CONFIG_PLACEHOLDERS,
    )
    expect(missing).toEqual([{ key: 'image', configField: 'imageTemplate' }])

    const refusal = describeUnfilledConfigPlaceholders(missing)
    // The two things the apiserver's own error could never say: which placeholder, and which
    // setting fills it. Without both, the only actionable-looking target is the manifest.
    expect(refusal).toContain('{{image}}')
    expect(refusal).toContain('imageTemplate')
    // And the explicit exoneration of the file, because that is what stops the next reader (human
    // or agent) from editing it.
    expect(refusal).toContain('The repository is not at fault')
  })

  it('resolves cleanly once the connection supplies the image, so the refusal is not a blanket ban', () => {
    const vars = { namespace: 'cf-env-4', image: 'ghcr.io/acme/catalog-api:pr-4' }
    expect(
      unresolvedPlaceholders(CATALOG_API_MANIFEST, vars, KUBERNETES_CONFIG_PLACEHOLDERS),
    ).toEqual([])
    expect(describeUnfilledConfigPlaceholders([])).toBeNull()
  })

  it('does not refuse a template whose only unresolved key is one the RUN supplies', () => {
    // The regression this scope exists to prevent. `frontendOrigins` is omitted for a service no
    // frontend binds and `peerEnvUrls` for the first frame of a fan-out, so a manifest folding
    // either into a CORS allow-list is correct AND has them unresolved on a perfectly ordinary
    // provision. Refusing there would fail the deployment with advice naming no setting anyone
    // could change, the same unactionable report the refusal was built to replace.
    const manifest = 'metadata:\n  annotations:\n    cors: "{{frontendOrigins}} {{peerEnvUrls}}"\n'
    const missing = unresolvedPlaceholders(
      manifest,
      { namespace: 'cf-env-4' },
      KUBERNETES_CONFIG_PLACEHOLDERS,
    )
    expect(missing.map((m) => m.key)).toEqual(['frontendOrigins', 'peerEnvUrls'])
    // Reported as unresolved (that is a fact about the render) and NOT refused (that is a
    // judgement about whose fault it is).
    expect(missing.every((m) => m.configField === undefined)).toBe(true)
    expect(describeUnfilledConfigPlaceholders(missing)).toBeNull()
  })

  it('refuses the config-backed key even when run-supplied keys are unresolved beside it', () => {
    // The mixed case: one key an operator can act on, two nobody can. The refusal names only the
    // first, so it does not send anyone looking for a `frontendOrigins` setting that never existed.
    const missing = unresolvedPlaceholders(
      `${CATALOG_API_MANIFEST}\n# cors: {{frontendOrigins}}\n`,
      { namespace: 'cf-env-4' },
      KUBERNETES_CONFIG_PLACEHOLDERS,
    )
    const refusal = describeUnfilledConfigPlaceholders(missing)
    expect(refusal).toContain('imageTemplate')
    expect(refusal).not.toContain('frontendOrigins')
  })

  it('treats a connection field set to a blank string as unsupplied', () => {
    // An operator who saved an empty `imageTemplate` has supplied nothing, and the manifest breaks
    // identically to the unset case — so it must classify identically rather than rendering ''
    // and blaming the file.
    const missing = unresolvedPlaceholders(
      CATALOG_API_MANIFEST,
      { image: '' },
      KUBERNETES_CONFIG_PLACEHOLDERS,
    )
    expect(missing).toEqual([{ key: 'image', configField: 'imageTemplate' }])
  })
})

describe('classifyApplyFailure', () => {
  it('classifies the real 422 as a manifest rejection', () => {
    expect(classifyApplyFailure(422, APISERVER_422_BODY)).toBe('manifest_invalid')
  })

  it('keeps credentials and reachability apart from the manifest', () => {
    // Each of these has a different remedy and a different owner, which is the entire reason this
    // is a vocabulary rather than a boolean.
    expect(classifyApplyFailure(401, '')).toBe('permission_denied')
    expect(classifyApplyFailure(403, 'forbidden')).toBe('permission_denied')
    expect(classifyApplyFailure(503, '<html>gateway</html>')).toBe('cluster_unreachable')
    // A missing API group is a cluster these manifests were not written for, which no edit to
    // them is the agreed fix for.
    expect(classifyApplyFailure(404, '')).toBe('config_incomplete')
  })

  it('answers null rather than guessing when the status carries no rule', () => {
    // Unclassified must stay distinguishable from classified: it is what keeps a fixer away from
    // a failure nobody understood.
    expect(classifyApplyFailure(302, '')).toBeNull()
    expect(isRepoFixableEnvironmentFailure(classifyApplyFailure(302, ''))).toBe(false)
  })

  it('keeps a 4xx the apiserver did not blame the document for out of the manifest class', () => {
    // A 400 carries more than document rejections. Each of these means the request could not be
    // PROCESSED, not that the manifests were wrong, and calling any of them repo-fixable spends a
    // `deploy-fixer` on files that were already correct.
    for (const reason of ['Timeout', 'Conflict', 'Forbidden', 'ServerTimeout']) {
      const body = JSON.stringify({ kind: 'Status', reason, code: 400 })
      expect(classifyApplyFailure(400, body)).toBeNull()
      expect(isRepoFixableEnvironmentFailure(classifyApplyFailure(400, body))).toBe(false)
    }
  })

  it('degrades to unclassified when the body is not an apiserver Status at all', () => {
    // A body that will not parse is as likely to be an ingress or proxy error page as anything
    // the apiserver said, so there is no evidence the document was refused on its merits. The
    // allow-list decides in both directions or it decides nothing.
    expect(classifyApplyFailure(422, 'not json at all')).toBeNull()
    expect(classifyApplyFailure(400, '<html>502 Bad Gateway</html>')).toBeNull()
  })

  it('admits every reason the allow-list names, at each status that carries one', () => {
    for (const status of [400, 415, 422]) {
      for (const reason of ['Invalid', 'BadRequest', 'UnsupportedMediaType']) {
        expect(classifyApplyFailure(status, JSON.stringify({ kind: 'Status', reason }))).toBe(
          'manifest_invalid',
        )
      }
    }
  })
})

describe('classifyWorkloadFailure', () => {
  it('routes image failures away from the repository', () => {
    // The class most likely to tempt a repair, and the one where a repair is a step from editing
    // the workflow that publishes the image.
    const reason = classifyWorkloadFailure('ImagePullBackOff: Back-off pulling image "acme:pr-4"')
    expect(reason).toBe('image_unavailable')
    expect(isRepoFixableEnvironmentFailure(reason)).toBe(false)
  })

  it('reports a crash loop as an unhealthy workload, not a broken manifest', () => {
    const reason = classifyWorkloadFailure('CrashLoopBackOff: back-off 5m restarting')
    expect(reason).toBe('workload_unhealthy')
    expect(isRepoFixableEnvironmentFailure(reason)).toBe(false)
  })

  it('reads a kubelet config error as a cluster-side absence', () => {
    expect(classifyWorkloadFailure('CreateContainerConfigError: secret "db" not found')).toBe(
      'config_incomplete',
    )
  })

  it('answers null with no terminal reason to go on', () => {
    expect(classifyWorkloadFailure(null)).toBeNull()
  })
})

describe('isRepoFixableEnvironmentFailure', () => {
  it('admits only a manifest the platform rejected on its own merits', () => {
    // Read off the picklist the code reads, not a copy of it: a member added to the vocabulary
    // arrives here on its own and has to be admitted deliberately, where a hand-kept list would
    // just stay silent about it. Stated as the RELATION (exactly one member is fixable, and it is
    // this one) rather than as a count, which every ordinary addition would break for no reason.
    const reasons = environmentFailureReasonSchema.options
    expect(reasons.filter((r) => isRepoFixableEnvironmentFailure(r))).toEqual(['manifest_invalid'])
  })

  it('treats an absent or unknown reason as not fixable', () => {
    // "We could not tell what went wrong" is not evidence that a checkout edit would help.
    expect(isRepoFixableEnvironmentFailure(null)).toBe(false)
    expect(isRepoFixableEnvironmentFailure(undefined)).toBe(false)
    expect(isRepoFixableEnvironmentFailure('something_new')).toBe(false)
  })
})
