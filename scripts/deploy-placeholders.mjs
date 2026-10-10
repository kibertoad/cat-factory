// Detection for `check-deploy-placeholders.mjs`, split out so its rules are testable in
// isolation (`scripts/deploy-placeholders.test.mjs`): the same split, for the same reason, as
// `reserved-env-keys.mjs` and `silent-catch.mjs`.
//
// The invariant it detects violations of: the `deploy/*` wrangler configs are TEMPLATES, so
// every account id, resource id and hostname in a LIVE (non-comment) line is a
// `REPLACE_WITH_*` placeholder or an example/localhost name. Three READMEs and the template
// headers promise exactly that, and the promise is what keeps a half-configured copy failing
// loudly instead of landing on a stranger's account. The guard is what keeps the promise
// true: without it, a maintainer testing a real deployment can commit a filled-in config
// (the state these files were in before they were requalified as templates) and re-publish
// their own account ids with nothing failing.
//
// Three rules, each aimed at a concrete Cloudflare identifier shape:
//   - a run of 32+ lowercase hex characters (an account id, e.g. inside a
//     `registry.cloudflare.com/<account>/...` image ref);
//   - a UUID (a D1 `database_id`);
//   - a URL whose host is neither a placeholder, an example/localhost name, nor the public
//     GitHub API default. A real `*.workers.dev` origin names the account's subdomain, so it
//     fails this rule too.
// Comment lines are skipped: that is where vendor documentation links legitimately live.

const HEX_ID = /(?<![0-9a-z])[0-9a-f]{32,}(?![0-9a-z])/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const URL_HOST = /https?:\/\/([^/:"'\s]+)/g

function hostIsAllowed(host) {
  if (host.includes('REPLACE_WITH_')) return true
  if (host === 'localhost' || host === '127.0.0.1') return true
  if (host === 'example.com' || host.endsWith('.example.com')) return true
  // The public GitHub API base is a product default, not a deployment's identity.
  if (host === 'api.github.com') return true
  return false
}

/**
 * Scans one template's content and returns every identifier a template may not carry:
 * `{ line, kind, token }` per hit, 1-indexed lines, empty array when clean.
 */
export function findLeakedIdentifiers(content) {
  const findings = []
  content.split('\n').forEach((text, index) => {
    if (/^\s*#/.test(text)) return
    const line = index + 1
    for (const match of text.matchAll(HEX_ID)) {
      findings.push({ line, kind: 'account-id', token: match[0] })
    }
    for (const match of text.matchAll(UUID)) {
      findings.push({ line, kind: 'resource-id', token: match[0] })
    }
    for (const match of text.matchAll(URL_HOST)) {
      if (!hostIsAllowed(match[1])) {
        findings.push({ line, kind: 'hostname', token: match[1] })
      }
    }
  })
  return findings
}
