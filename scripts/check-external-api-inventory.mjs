#!/usr/bin/env node
// Requires every file that makes an outbound HTTP call to be classified as either a VENDOR surface
// this repo sweeps or an INTERNAL one it does not.
//
// The rule it protects: almost every third-party surface here is reached by HAND (a path we typed,
// a version header we pinned, a JSON field we read by name), so nothing in CI can see the vendor
// move one. The `external-api-sweep` skill exists to catch that by reading the vendor's
// live docs, and its whole guarantee is that its inventory is COMPLETE. Left to regexes an agent
// retypes each run, it is not: the skill's own worked example counted four GitHub API-version pins
// where the tree has fourteen, and Confluence and Zeplin were invisible to both of its greps
// because one calls through `safeFetch` and the other builds its host from a template literal.
//
// So the inventory is derived here, once, in code the sweep runs instead of re-deriving. The guard
// half is the direction the sweep cannot cover on its own: a new integration lands between sweeps
// and stays unswept for however many months until the next one. This fails in THAT pull request,
// and the fix is one line naming the vendor.
//
// Deliberately not asserted here: whether the vendor's docs still say what we send. That is a
// claim about a vendor page on a date, which only the sweep can make. This guard asserts the
// weaker, checkable half: that no outbound call is unaccounted for.
//
// Both directions are checked. An unclassified file is the hole; an entry matching no file is the
// map rotting into fiction, which is worse than absence because it reads as evidence.
//
// Usage:  node scripts/check-external-api-inventory.mjs          (check; exit 1 on drift)
//         node scripts/check-external-api-inventory.mjs --list   (print the derived inventory)
// Exit 0 = every outbound call is classified; exit 1 = at least one is not.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  makesOutboundCall,
  malformedEntries,
  sweptVendors,
  unclassifiedFiles,
  unmatchedEntries,
} from './external-api-inventory.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Where source that can talk to the outside world lives. */
const ROOTS = ['backend', 'frontend', 'scripts', 'sdk']

/** Build output, dependencies and caches: derived, and none of it ours to classify. */
const SKIP_DIRS = new Set([
  '.git',
  '.nuxt',
  '.output',
  '.turbo',
  '.wrangler',
  'coverage',
  'dist',
  'node_modules',
])

const SOURCE = /\.(ts|mts|mjs|vue)$/

/**
 * Test source is excluded: a spec's fetch is against a fake it stood up itself, and a fake
 * mirroring a vendor's shape is found by the version-pin grep, not by a call-site walk.
 */
const TEST_SOURCE = /(\.test\.|\.spec\.|(^|\/)(test|tests|__tests__|test-support)\/)/

/**
 * Every outbound call site, classified.
 *
 * kind 'vendor' means a service we do not run, reached over a path WE typed: it belongs in the
 * sweep, and `vendors` names whose docs settle it. kind 'internal' means the call stays inside
 * something this repo defines: our own /api/v1 and /internal/*, a runner or container we
 * dispatched, a probe against localhost. No vendor page can make one of those wrong. A path
 * ending in a slash covers the directory; the longest match wins.
 */
const CLASSIFICATION = [
  // ---- vendor surfaces, swept ------------------------------------------------------------
  {
    path: 'backend/internal/executor-harness/src/vcs-api.ts',
    kind: 'vendor',
    vendors: ['github', 'gitlab'],
  },
  { path: 'backend/packages/gitlab/src/', kind: 'vendor', vendors: ['gitlab'] },
  {
    path: 'backend/packages/integrations/src/modules/cloudflare/',
    kind: 'vendor',
    vendors: ['cloudflare'],
  },
  {
    path: 'backend/packages/integrations/src/modules/datadog/',
    kind: 'vendor',
    vendors: ['datadog'],
  },
  {
    path: 'backend/packages/integrations/src/modules/documents/ConfluenceProvider.ts',
    kind: 'vendor',
    vendors: ['confluence'],
  },
  {
    path: 'backend/packages/integrations/src/modules/documents/DocumentSourceOAuthService.ts',
    kind: 'vendor',
    vendors: ['figma', 'notion', 'zeplin'],
  },
  {
    path: 'backend/packages/integrations/src/modules/documents/FigmaProvider.ts',
    kind: 'vendor',
    vendors: ['figma'],
  },
  {
    path: 'backend/packages/integrations/src/modules/documents/NotionProvider.ts',
    kind: 'vendor',
    vendors: ['notion'],
  },
  {
    path: 'backend/packages/integrations/src/modules/documents/ZeplinProvider.ts',
    kind: 'vendor',
    vendors: ['zeplin'],
  },
  {
    path: 'backend/packages/integrations/src/modules/email/',
    kind: 'vendor',
    vendors: ['resend', 'sendgrid'],
  },
  {
    path: 'backend/packages/integrations/src/modules/github/',
    kind: 'vendor',
    vendors: ['github'],
  },
  {
    path: 'backend/packages/integrations/src/modules/incidentio/',
    kind: 'vendor',
    vendors: ['incident.io'],
  },
  {
    path: 'backend/packages/integrations/src/modules/kubernetes/KubernetesApiClient.ts',
    kind: 'vendor',
    vendors: ['kubernetes'],
  },
  {
    path: 'backend/packages/integrations/src/modules/mcpOAuth/',
    kind: 'vendor',
    vendors: ['mcp-authorization'],
  },
  {
    path: 'backend/packages/integrations/src/modules/pagerduty/',
    kind: 'vendor',
    vendors: ['pagerduty'],
  },
  {
    path: 'backend/packages/integrations/src/modules/providers/githubPatCapability.ts',
    kind: 'vendor',
    vendors: ['github'],
  },
  {
    path: 'backend/packages/integrations/src/modules/shared/linear.client.ts',
    kind: 'vendor',
    vendors: ['linear'],
  },
  { path: 'backend/packages/integrations/src/modules/slack/', kind: 'vendor', vendors: ['slack'] },
  { path: 'backend/packages/integrations/src/modules/tasks/', kind: 'vendor', vendors: ['jira'] },
  {
    path: 'backend/packages/integrations/src/modules/tracker/TicketTrackerService.ts',
    kind: 'vendor',
    vendors: ['jira', 'linear'],
  },
  {
    path: 'backend/packages/integrations/src/modules/tracker/github.create.logic.ts',
    kind: 'vendor',
    vendors: ['github'],
  },
  { path: 'backend/packages/observability-langfuse/', kind: 'vendor', vendors: ['langfuse'] },
  { path: 'backend/packages/observability-otel/', kind: 'vendor', vendors: ['otlp'] },
  { path: 'backend/packages/server/src/auth/GitHubOAuth.ts', kind: 'vendor', vendors: ['github'] },
  { path: 'backend/packages/server/src/auth/GoogleOAuth.ts', kind: 'vendor', vendors: ['google'] },
  { path: 'backend/packages/server/src/auth/LinearOAuth.ts', kind: 'vendor', vendors: ['linear'] },
  { path: 'backend/packages/server/src/github/', kind: 'vendor', vendors: ['github'] },
  {
    path: 'backend/packages/server/src/modules/llmProxy/',
    kind: 'vendor',
    vendors: ['openai-compatible'],
  },
  {
    path: 'backend/packages/server/src/modules/webSearch/',
    kind: 'vendor',
    vendors: ['brave-search', 'searxng'],
  },
  { path: 'backend/runtimes/local/src/github.ts', kind: 'vendor', vendors: ['github'] },
  { path: 'backend/runtimes/local/src/linkRepo.ts', kind: 'vendor', vendors: ['github'] },
  { path: 'scripts/check-release-versions.mjs', kind: 'vendor', vendors: ['npm-registry'] },

  // ---- our own surfaces, excluded ---------------------------------------------------------
  {
    path: 'backend/internal/acceptance/',
    kind: 'internal',
    reason:
      'acceptance fakes that SERVE a vendor-shaped API; they mirror a pin rather than send one',
  },
  {
    path: 'backend/internal/e2e/',
    kind: 'internal',
    reason: 'drives our own SPA and backend',
  },
  {
    path: 'backend/internal/executor-harness/src/',
    kind: 'internal',
    reason:
      'job-local: artifact downloads from a URL the backend supplied, and localhost readiness probes',
  },
  {
    path: 'backend/internal/sdk-smoketest/',
    kind: 'internal',
    reason: 'exercises our own /api/v1 through the published clients',
  },
  {
    path: 'backend/packages/integrations/src/modules/compose/',
    kind: 'internal',
    reason: 'healthchecks a compose service the run itself started',
  },
  {
    path: 'backend/packages/integrations/src/modules/documents/http.ts',
    kind: 'internal',
    reason:
      'the host-pinned transport the document providers share; carries no vendor path of its own',
  },
  {
    path: 'backend/packages/integrations/src/modules/environments/',
    kind: 'internal',
    reason: 'a deployment-supplied environment provider speaking OUR contract',
  },
  {
    path: 'backend/packages/integrations/src/modules/notificationWebhook/',
    kind: 'internal',
    reason: 'outbound delivery to a subscriber endpoint, on the webhook contract we publish',
  },
  {
    path: 'backend/packages/integrations/src/modules/runners/',
    kind: 'internal',
    reason: 'a workspace self-hosted runner pool speaking OUR contract',
  },
  {
    path: 'backend/packages/integrations/src/modules/shared/safe-fetch.ts',
    kind: 'internal',
    reason: 'the SSRF-guarded transport itself; every vendor call above goes through it',
  },
  {
    path: 'backend/packages/server/src/events/',
    kind: 'internal',
    reason: 'internal machine RPC between our own processes',
  },
  {
    path: 'backend/packages/server/src/github/DelegatedAppTokenSource.ts',
    kind: 'internal',
    reason: 'POST /internal/github/installation-token on the mothership, not GitHub',
  },
  {
    path: 'backend/packages/server/src/notifications/',
    kind: 'internal',
    reason: 'internal machine RPC between our own processes',
  },
  {
    path: 'backend/packages/server/src/persistence/',
    kind: 'internal',
    reason: 'the /internal/persistence RPC a mothership node reads its repositories over',
  },
  {
    path: 'backend/packages/server/src/telemetry/',
    kind: 'internal',
    reason: 'internal machine RPC between our own processes',
  },
  {
    path: 'backend/runtimes/local/src/harnessHttp.ts',
    kind: 'internal',
    reason: 'the run container this process just dispatched',
  },
  {
    path: 'backend/runtimes/local/src/mothership.ts',
    kind: 'internal',
    reason: 'the mothership /internal surface',
  },
  {
    path: 'backend/runtimes/local/src/preflight.ts',
    kind: 'internal',
    reason: 'a generic reachability probe; the URL is whatever a preflight check names',
  },
  {
    path: 'frontend/app/',
    kind: 'internal',
    reason: 'the SPA reaches our own /api/v1 only; no browser code holds a vendor credential',
  },
]

/** Every non-test source file under the scanned roots. */
function sourceFiles() {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (SOURCE.test(entry.name)) found.push(relative(root, path).split(sep).join('/'))
    }
  }
  for (const dir of ROOTS) walk(join(root, dir))
  return found.filter((file) => !TEST_SOURCE.test(file))
}

const candidates = sourceFiles()
  .filter((file) => makesOutboundCall(readFileSync(join(root, file), 'utf8')))
  .sort()

if (process.argv.includes('--list')) {
  for (const file of candidates) console.log(file)
  process.exit(0)
}

const malformed = malformedEntries(CLASSIFICATION)
const unclassified = unclassifiedFiles(candidates, CLASSIFICATION)
const unmatched = unmatchedEntries(candidates, CLASSIFICATION)

if (malformed.length === 0 && unclassified.length === 0 && unmatched.length === 0) {
  const vendors = sweptVendors(CLASSIFICATION)
  console.log(
    `check-external-api-inventory: ${candidates.length} outbound call sites, all classified ` +
      `(${vendors.length} vendors swept: ${vendors.join(', ')}).`,
  )
  process.exit(0)
}

for (const fault of malformed) {
  console.error(`check-external-api-inventory: malformed entry, ${fault}`)
}
for (const file of unclassified) {
  console.error(
    `check-external-api-inventory: ${file} makes an outbound HTTP call and is classified nowhere.`,
  )
}
for (const path of unmatched) {
  console.error(
    `check-external-api-inventory: the entry for ${path} matches no call site; it has moved or gone.`,
  )
}
console.error(
  '\nAdd each to CLASSIFICATION in scripts/check-external-api-inventory.mjs: kind "vendor" with ' +
    'the vendor whose docs settle it (the external-api-sweep skill then verifies it), or kind ' +
    '"internal" with the reason no vendor page can make it wrong.',
)
process.exit(1)
