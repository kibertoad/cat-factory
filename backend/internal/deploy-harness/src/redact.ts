// Credential redaction for the deploy harness. Every string that may reach a log line
// or the polled job view (a kubectl/helm stderr, an error message) is scrubbed of:
//
//  - PATTERN-based shapes: URL userinfo (`https://user:pass@host`), the git
//    `x-access-token:<tok>` form, bare GitHub token prefixes, and `KEY=value` / `KEY:
//    value` assignments whose key names a credential (a helm `--set apiKey=…` echoed
//    back, a leaked env var in a chart hook's output).
//  - VALUE-based: a list of KNOWN secret strings — the apiserver bearer token, the git
//    token, and every resolved secret-injection / helm value the job carried in — so a
//    deploy that echoes a Secret's contents on a render error can't leak them verbatim.
//
// Mirrors the executor harness's redact module; kept local so the image carries no deps.

// Below this length a "known secret" is too short to scrub without mangling
// legitimate output (it would replace common substrings).
const MIN_REDACT_LEN = 6

// `KEY=value` / `KEY: value` assignments whose key NAMES a credential. The key token is
// matched within a surrounding identifier so `DB_ACCESS_KEY`/`api_key` are covered;
// `auth` is deliberately excluded so it can't clobber a git `Author:` line. The value is
// the first whitespace-delimited run.
const CREDENTIAL_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|key|credential)[A-Za-z0-9_]*\s*[:=]\s*)\S+/gi

/**
 * Strip credentials out of any string before it is logged or stored. Applies the pattern
 * rules (URL userinfo, `x-access-token:<token>`, bare `ghs_`/`ghp_`/`gho_`/`github_pat_`
 * shapes, and credential-named `KEY=value` / `KEY: value` assignments) and then scrubs
 * every supplied known-secret value. Idempotent — safe to call on already-redacted text.
 */
export function redact(input: string, knownSecrets: readonly string[] = []): string {
  let out = input
    .replace(/(https?:\/\/)[^@\s/]*@/gi, '$1***@')
    .replace(/x-access-token:[^@\s]+/gi, 'x-access-token:***')
    .replace(/\b(gh[pso]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
    .replace(CREDENTIAL_ASSIGNMENT, '$1***')
  for (const secret of knownSecrets) {
    if (secret.length >= MIN_REDACT_LEN) out = out.split(secret).join('***')
  }
  return out
}

/** Pattern-only redaction (no known values). Kept for callers without a secret list. */
export function redactSecrets(input: string): string {
  return redact(input)
}
