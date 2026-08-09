// The shape rule for a pasted Kubernetes ServiceAccount bearer token, shared by the SPA (which
// flags a bad paste on the field, before the operator ever clicks Test) and the backend (which
// refuses an unusable one before it can become an `authorization` header).
//
// It lives in contracts rather than kernel because BOTH sides have to agree about the answer:
// kernel is invisible to the SPA, so a rule kept there would be restated by hand on the form and
// the two would drift. What the backend must NOT do is phrase the verdict, so this returns a
// machine-readable code and the SPA maps it to a translated message (the CLAUDE.md rule for a
// localizable condition).
//
// Why it earns its place: the guided `cat-factory k3s` flow ends with "copy this token out of your
// terminal and paste it", and a terminal wraps long lines. A token copied across that wrap carries
// a newline in the MIDDLE, which is invisible in a password field, survives `.trim()`, and reaches
// undici as a header value it refuses to build. The operator sees a generic failure and has no way
// to tell it apart from a wrong token or a stopped cluster.

/**
 * What is wrong with a pasted ServiceAccount token, or `null` when nothing is.
 *
 * Split by SEVERITY, because the two halves earn different treatment:
 *
 * - `whitespace` is IMPOSSIBLE, not merely suspicious. No bearer token contains a space, tab or
 *   line break, and an HTTP header value structurally cannot carry one, so this is refused
 *   outright at both ends.
 * - `base64-encoded` and `not-a-jwt` are SUSPICIOUS. A Kubernetes ServiceAccount token is a JWT
 *   today, but the same field also serves any apiserver that accepts a static bearer token (a
 *   `--token-auth-file` cluster), whose tokens are arbitrary strings. So these are surfaced as a
 *   warning the operator can overrule, never as a refusal: a check that cannot be sure must not
 *   be the thing that blocks a legitimate cluster.
 */
export type ServiceAccountTokenProblem = 'whitespace' | 'base64-encoded' | 'not-a-jwt'

/** Whether a problem makes the token unusable (as opposed to merely unusual). */
export function isFatalServiceAccountTokenProblem(problem: ServiceAccountTokenProblem): boolean {
  return problem === 'whitespace'
}

/** A JWT: three non-empty base64url segments separated by dots. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/

/**
 * The base64 of a JWT always begins `eyJ` encoded, i.e. `ZXlK`. This is the `kubectl get secret
 * … -o jsonpath={.data.token}` value pasted WITHOUT the `| base64 -d`, which is a distinct mistake
 * from a malformed token and has a different fix, so it gets its own code rather than collapsing
 * into `not-a-jwt`.
 */
const BASE64_JWT_PREFIX = /^ZXlK/

/** Any whitespace, including the line break a wrapped terminal copy introduces. */
const ANY_WHITESPACE = /\s/

/**
 * Classify a pasted ServiceAccount token, or `null` when it looks fine (and for an EMPTY value,
 * which is the field's own required-ness question and not this rule's).
 *
 * Checked against the value with SURROUNDING whitespace trimmed, because leading/trailing padding
 * is both harmless and universally stripped before use. It is whitespace that survives the trim,
 * i.e. inside the token, that can never be right.
 */
export function classifyServiceAccountToken(raw: string): ServiceAccountTokenProblem | null {
  const token = raw.trim()
  if (!token) return null
  if (ANY_WHITESPACE.test(token)) return 'whitespace'
  if (BASE64_JWT_PREFIX.test(token)) return 'base64-encoded'
  if (!JWT_SHAPE.test(token)) return 'not-a-jwt'
  return null
}
