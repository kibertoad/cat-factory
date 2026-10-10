import type { EnvironmentFailureReason } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Classifying WHY a Kubernetes environment failed to come up.
//
// The provisioning path used to answer this with one flat `environment` failure kind carrying a
// verbatim apiserver string, which meant nothing downstream could tell "the manifests are wrong"
// from "the connection is unconfigured" from "the cluster refused our token". That was tolerable
// while the only consumer was a human reading the prose. It stopped being tolerable the moment an
// automated fixer could be dispatched at the failure, because the two causes want OPPOSITE
// responses and the wrong one is destructive: `manifest_invalid` wants a repair in the checkout,
// and `config_incomplete` wants a person to finish wiring the workspace, where a repair in the
// checkout can only mean hard-coding the value the platform was supposed to substitute.
//
// Pure and separate from the provider so every rule here is unit-testable against real payloads
// (see the fixtures taken from `exec_194b231198454c7785f29589`).
// ---------------------------------------------------------------------------

/**
 * Placeholder keys the Kubernetes backend supplies from CONNECTION config rather than from the
 * run, mapped to the field that supplies each. Handed to kernel's provider-neutral
 * `unresolvedPlaceholders`, which cannot know any one backend's configuration shape.
 *
 * This is the difference between a report that says `{{image}}` is empty and one that says it is
 * empty because this workspace's Kubernetes connection sets no `imageTemplate`. Only the second
 * tells anyone what to do, and it is the exact gap that made a correct manifest look at fault.
 */
export const KUBERNETES_CONFIG_PLACEHOLDERS: Record<string, string> = {
  image: 'imageTemplate',
}

/**
 * Kubernetes `Status.reason` values that mean the manifests were rejected on their own merits,
 * with every substitution resolved. These are the apiserver saying the DOCUMENT is wrong, which
 * is the one environment failure a checkout edit can fix.
 *
 * An allow-list, for the reason `TERMINAL_WAITING_REASONS` is one: an unrecognised reason
 * degrades to `unknown`, which is not repo-fixable, so a miss costs a remediation that would have
 * been possible rather than dispatching an agent at a cause it cannot address.
 */
const MANIFEST_REJECTION_REASONS = new Set(['Invalid', 'BadRequest', 'UnsupportedMediaType'])

/**
 * Classify a failed apiserver APPLY from its HTTP status and response body.
 *
 * `null` when nothing recognisable is present, which callers must treat as unclassified rather
 * than as any particular cause.
 */
export function classifyApplyFailure(
  status: number,
  body: string,
): EnvironmentFailureReason | null {
  if (status === 401 || status === 403) return 'permission_denied'
  // 404 on an apply is the API GROUP being absent (a CRD that was never installed), not a missing
  // object: server-side apply creates. That is a cluster the manifests were not written for,
  // which no edit to those manifests is the agreed fix for.
  if (status === 404) return 'config_incomplete'
  if (status === 422 || status === 400 || status === 415) {
    // The allow-list decides, in BOTH directions. These statuses carry more than document
    // rejections: a 400 can come back as `Timeout`, `Conflict` or `Forbidden`, none of which the
    // manifests are at fault for, and a body that does not parse as a `Status` is as likely to be
    // an ingress or proxy error page as anything the apiserver said. Answering `manifest_invalid`
    // for those spends a `deploy-fixer` on files that were never wrong, the one outcome this
    // classification exists to prevent, so anything unrecognised degrades to unclassified, which
    // is not repo-fixable. A miss costs a remediation that was possible; a false positive costs a
    // plausible edit to something that was already correct.
    const reason = readStatusReason(body)
    return reason && MANIFEST_REJECTION_REASONS.has(reason) ? 'manifest_invalid' : null
  }
  if (status >= 500) return 'cluster_unreachable'
  return null
}

/** The `reason` field of a Kubernetes `Status` response body, when it parses and carries one. */
function readStatusReason(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return null
    const status = parsed as { kind?: unknown; reason?: unknown }
    if (status.kind !== 'Status') return null
    return typeof status.reason === 'string' ? status.reason : null
  } catch {
    // A non-JSON body is an ingress/proxy error page rather than an apiserver Status; the caller's
    // HTTP-status branch is the honest classification and there is nothing to add from the text.
    // silent-catch-ok: a parse failure IS the answer here (no reason available), and the body is
    // already carried verbatim on the failure the caller raises.
    return null
  }
}

/**
 * Classify a workload that applied cleanly and then failed to become ready, from the terminal
 * kubelet reason the pod walk found (`analyzePodStatus`).
 *
 * The image reasons are split out from the rest because they are the class most likely to tempt a
 * repair: "no image to pull" reads like a manifest problem and is almost never one. The image is
 * produced by CI, so the fix is a published tag or a pull secret, and an agent asked to fix it in
 * the checkout is one step from editing the workflow that builds it. That is a merge-time
 * credential-exfiltration path, which is why this classification is what gates the dispatch
 * rather than a line in the agent's prompt asking it not to.
 */
const IMAGE_FAILURE_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'ErrImageNeverPull',
  'ErrInvalidImageName',
  'InvalidImageName',
  'ImageInspectError',
  'RegistryUnavailable',
])

/** See {@link IMAGE_FAILURE_REASONS}. `null` when the reason is not one we classify. */
export function classifyWorkloadFailure(terminal: string | null): EnvironmentFailureReason | null {
  if (!terminal) return null
  // `analyzePodStatus` returns the reason joined with its message; match on the leading token.
  const reason = terminal.split(/[\s:]/, 1)[0] ?? ''
  if (IMAGE_FAILURE_REASONS.has(reason)) return 'image_unavailable'
  // A config error the KUBELET raises (a missing ConfigMap/Secret key a container mounts) is a
  // cluster-side absence, not a malformed document: the manifest names something that does not
  // exist where it is being deployed.
  if (reason === 'CreateContainerConfigError') return 'config_incomplete'
  return 'workload_unhealthy'
}
