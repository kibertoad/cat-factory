// Deploy-harness image resolution for local mode's `container` deploy runner.
//
// The Kubernetes deploy runner (renders + applies a service's manifests with real
// kubectl/kustomize/helm) can run in `container` mode as the deploy-harness IMAGE, versioned as
// its OWN Docker image (published by CI as `ghcr.io/<owner>/cat-factory-deploy:<deploy-harness
// version>`), separately from the @cat-factory/* npm packages — exactly like the executor-harness
// image (see harnessImage.ts). So the same resolution applies: `LOCAL_DEPLOY_IMAGE` is an OPTIONAL
// escape hatch, and when it is unset the runner uses `RECOMMENDED_DEPLOY_IMAGE` — the exact image
// this build of `@cat-factory/local-server` was released against. A developer who just wants a
// working Kubernetes test environment sets `LOCAL_DEPLOY_RUNTIME=container` and nothing else; the
// image is resolved automatically to a version the current backend supports.
//
// RELEASE RULE: `RECOMMENDED_DEPLOY_IMAGE` is kept in lockstep with the deploy-harness image tag by
// scripts/sync-runner-image-tags.mjs (this file is listed as an `extraPins` target of the `deploy`
// image descriptor in scripts/runner-images.mjs) — the SAME machinery that keeps the Worker's
// `deploy/backend/wrangler.toml` pin in step. So the recommended local default, the Worker's pinned
// image, and the deploy-harness `version` are always the same supported version; do not hand-edit
// the tag here (the release `version` script re-derives it).

/**
 * The deploy-harness image this backend release is matched to. Kept in sync with
 * `@cat-factory/deploy-harness`'s version (the value CI tags the published image with, and the same
 * tag `deploy/backend` pins) by the runner-image-tag sync — do not bump it by hand.
 */
export const RECOMMENDED_DEPLOY_IMAGE = 'ghcr.io/kibertoad/cat-factory-deploy:0.2.7'

/**
 * The effective deploy-harness image ref for `container` mode: an explicit `LOCAL_DEPLOY_IMAGE`
 * wins (a custom build, a different pin, or a private-registry mirror), else the backend-matched
 * {@link RECOMMENDED_DEPLOY_IMAGE}. So `container` mode needs no companion variable to work.
 */
export function resolveDeployImage(env: NodeJS.ProcessEnv): string {
  return env.LOCAL_DEPLOY_IMAGE?.trim() || RECOMMENDED_DEPLOY_IMAGE
}
