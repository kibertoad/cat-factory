import { computed, type ComputedRef, type Ref } from 'vue'
import {
  classifyServiceAccountToken,
  isFatalServiceAccountTokenProblem,
  type ServiceAccountTokenProblem,
} from '@cat-factory/contracts'

// Inline validation of a pasted Kubernetes ServiceAccount token, shared by the two kube connect
// forms so they cannot drift on what a bad paste is or on what to say about it.
//
// The rule itself is in `@cat-factory/contracts` because the backend enforces the same one (see
// `KubernetesApiClient`), and this is the SPA half of the split CLAUDE.md prescribes: the backend
// emits a machine-readable code, the SPA owns the translated prose. So the map below is the one
// place a problem code becomes copy.

/**
 * The message key per problem, as an exhaustive `Record`: a code added to the contract union fails
 * the typecheck here until it has copy, rather than rendering as a silently missing hint. The keys
 * are literals for the same reason they are elsewhere in the SPA (an assembled key is invisible to
 * the typed-message-key check), and they sit under the shared `providerConnection` namespace
 * because both the per-type engine form and the legacy single-connection form show them.
 */
const MESSAGE_KEYS: Record<ServiceAccountTokenProblem, string> = {
  whitespace: 'settings.providerConnection.serviceAccountToken.whitespace',
  'base64-encoded': 'settings.providerConnection.serviceAccountToken.base64Encoded',
  'not-a-jwt': 'settings.providerConnection.serviceAccountToken.notAJwt',
}

export interface ServiceAccountTokenCheck {
  /** The problem code, or null when the value looks fine (and when it is empty). */
  problem: ComputedRef<ServiceAccountTokenProblem | null>
  /**
   * Whether the problem should BLOCK Test and Save. True only for the impossible case (whitespace
   * inside the token), never for the merely-suspicious shapes: a `--token-auth-file` apiserver
   * accepts an arbitrary static bearer token, and a check that cannot be sure must not be the
   * thing that stops a legitimate cluster being configured.
   */
  blocking: ComputedRef<boolean>
  /** The translated hint to render under the field, or '' when there is nothing to say. */
  message: ComputedRef<string>
}

/** Classify the live value of a token field and render the verdict as translated copy. */
export function useServiceAccountTokenProblem(token: Ref<string>): ServiceAccountTokenCheck {
  const { t } = useI18n()
  const problem = computed(() => classifyServiceAccountToken(token.value))
  return {
    problem,
    blocking: computed(() => !!problem.value && isFatalServiceAccountTokenProblem(problem.value)),
    message: computed(() => (problem.value ? t(MESSAGE_KEYS[problem.value]) : '')),
  }
}
