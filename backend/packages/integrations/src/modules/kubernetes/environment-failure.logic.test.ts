import { describe, expect, it } from 'vitest'
import { describeUnresolvedPlaceholders, unresolvedPlaceholders } from '@cat-factory/kernel'
import { isRepoFixableEnvironmentFailure } from '@cat-factory/contracts'
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

    const refusal = describeUnresolvedPlaceholders(missing)
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
    expect(describeUnresolvedPlaceholders([])).toBeNull()
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

  it('survives a non-JSON body without losing the status-derived class', () => {
    expect(classifyApplyFailure(422, 'not json at all')).toBe('manifest_invalid')
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
    // Derived from the vocabulary rather than re-listed, so a member added to the picklist without
    // a decision here fails this assertion instead of silently inheriting one.
    expect(isRepoFixableEnvironmentFailure('manifest_invalid')).toBe(true)
    for (const reason of [
      'deploy_runner_unwired',
      'config_incomplete',
      'image_unavailable',
      'workload_unhealthy',
      'permission_denied',
      'cluster_unreachable',
      'timeout',
    ]) {
      expect(isRepoFixableEnvironmentFailure(reason)).toBe(false)
    }
  })

  it('treats an absent or unknown reason as not fixable', () => {
    // "We could not tell what went wrong" is not evidence that a checkout edit would help.
    expect(isRepoFixableEnvironmentFailure(null)).toBe(false)
    expect(isRepoFixableEnvironmentFailure(undefined)).toBe(false)
    expect(isRepoFixableEnvironmentFailure('something_new')).toBe(false)
  })
})
