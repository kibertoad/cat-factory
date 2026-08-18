#!/usr/bin/env node
// Requires every file that reaches an external API to be classified as either a VENDOR surface
// this repo sweeps, an INTERNAL one it does not, or an SDK-mediated one a dependency bump owns.
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
// TWO directions reach a vendor, and the second is not a smaller version of the first. We SEND the
// request, or we DECLARE the endpoint and something else sends it: a binary generator's descriptor
// an AGENT calls with its own credential, a provider base URL an SDK appends a path to. Both are
// ours to get wrong and neither is visible to the other's detector, which is how a hand-written
// Gemini image contract sat outside an inventory that reported itself complete.
//
// Deliberately not asserted here: whether the vendor's docs still say what we send. That is a
// claim about a vendor page on a date, which only the sweep can make. This guard asserts the
// weaker, checkable half: that no external surface is unaccounted for.
//
// Four directions are checked, because each catches what the others structurally cannot. An
// unclassified file is the hole. An entry matching no file is the map rotting into fiction, which
// is worse than absence because it reads as evidence. A malformed entry is a claim with no
// content. And a vendor entry whose files declare a host it does not list is the absorption bug: a
// directory-wide row is otherwise unable to fail, so a new vendor beside a swept one inherits its
// verdict.
//
// Known limit, stated because a silent one reads as coverage: the walk reads JS/TS source. The
// Python, Go and Java SDK transports are hand-written and unreadable to it, which is why `sdk/`
// carries one entry arguing about what all four clients TALK TO rather than four derivations.
//
// Usage:  node scripts/check-external-api-inventory.mjs          (check; exit 1 on drift)
//         node scripts/check-external-api-inventory.mjs --list   (the derived inventory, as TSV)
// Exit 0 = every external surface is classified; exit 1 = at least one is not, in both modes.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classificationFor,
  declaresVendorEndpoint,
  makesOutboundCall,
  malformedEntries,
  sweptVendors,
  unclassifiedFiles,
  unmatchedEntries,
  vendorEndpointHosts,
  vendorEvidenceGaps,
} from './external-api-inventory.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where source that can talk to the outside world lives. `deploy/` is in because a deployment
 * COPIES it: leaving it out was a narrowing with no reason recorded, and every exclusion in this
 * file owes one.
 */
const ROOTS = ['backend', 'deploy', 'frontend', 'scripts', 'sdk']

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

/**
 * Every extension a hand-written call could arrive in. `.js`, `.cjs` and `.tsx` match nothing
 * today and are listed anyway: a walk that would not have SEEN the file is the failure this guard
 * exists to prevent, and finding out by adding one is finding out too late.
 */
const SOURCE = /\.(ts|tsx|mts|mjs|cjs|js|vue)$/

/**
 * Test source is excluded: a spec's fetch is against a fake it stood up itself, and a fixture's
 * base URL is a reserved `.test` host no vendor page settles.
 */
const TEST_SOURCE = /(\.test\.|\.spec\.|\.fixtures\.|(^|\/)(test|tests|__tests__|test-support)\/)/

/**
 * Every external call site and endpoint declaration, classified.
 *
 * kind 'vendor' means a service we do not run, reached over a path WE typed: it belongs in the
 * sweep, and `vendors` names whose docs settle it. kind 'internal' means the call stays inside
 * something this repo defines: our own /api/v1 and /internal/*, a runner or container we
 * dispatched, a probe against localhost. kind 'sdk' means it does leave the building, but on a
 * wire shape a pinned dependency owns, so currency is a version bump rather than a sweep. A path
 * ending in a slash covers the directory; the longest match wins.
 *
 * A `vendor` entry's files have to SUPPORT its vendors: declare only hosts one of them accounts
 * for, or at least name one. Where the identity genuinely lives elsewhere (a Jira site and a
 * self-hosted GitLab arrive entirely from config), `evidence: '<why>'` waives that, and costs the
 * sentence a reader would otherwise have to reconstruct.
 */
const CLASSIFICATION = [
  // ---- vendor surfaces, swept ------------------------------------------------------------
  {
    path: 'backend/internal/acceptance/src/repoContentApi.ts',
    kind: 'vendor',
    vendors: ['github'],
  },
  { path: 'backend/internal/acceptance/src/vcsIssues.ts', kind: 'vendor', vendors: ['github'] },
  {
    path: 'backend/internal/executor-harness/src/vcs-api.ts',
    kind: 'vendor',
    vendors: ['github', 'gitlab'],
  },
  {
    path: 'backend/packages/agents/src/providers/endpoints.ts',
    kind: 'vendor',
    vendors: [
      'alibaba-dashscope',
      'cloudflare',
      'deepseek',
      'moonshot',
      'openai',
      'openrouter',
      'x-ai',
    ],
  },
  {
    path: 'backend/packages/binary-generators/src/contracts/nano-banana.openapi.ts',
    kind: 'vendor',
    vendors: ['google-gemini'],
  },
  {
    path: 'backend/packages/binary-generators/src/generators/nano-banana.ts',
    kind: 'vendor',
    vendors: ['google-gemini'],
  },
  { path: 'backend/packages/gitlab/src/', kind: 'vendor', vendors: ['gitlab'] },
  {
    path: 'backend/packages/integrations/src/modules/cloudflare/',
    kind: 'vendor',
    vendors: ['cloudflare', 'github'],
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
    path: 'backend/packages/integrations/src/modules/documents/figma.logic.ts',
    kind: 'vendor',
    vendors: ['figma'],
  },
  {
    path: 'backend/packages/integrations/src/modules/documents/zeplin.logic.ts',
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
    path: 'backend/packages/integrations/src/modules/providers/OpenRouterCatalogService.ts',
    kind: 'vendor',
    vendors: ['openrouter'],
  },
  {
    path: 'backend/packages/integrations/src/modules/providers/githubPatCapability.ts',
    kind: 'vendor',
    vendors: ['github'],
  },
  {
    path: 'backend/packages/integrations/src/modules/providers/userSecretKinds.ts',
    kind: 'vendor',
    vendors: ['github'],
  },
  {
    path: 'backend/packages/integrations/src/modules/shared/linear.client.ts',
    kind: 'vendor',
    vendors: ['linear'],
  },
  { path: 'backend/packages/integrations/src/modules/slack/', kind: 'vendor', vendors: ['slack'] },
  {
    path: 'backend/packages/integrations/src/modules/tasks/',
    kind: 'vendor',
    vendors: ['github', 'gitlab', 'jira', 'linear'],
  },
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
  {
    path: 'backend/packages/kernel/src/domain/models.ts',
    kind: 'vendor',
    vendors: ['deepseek', 'moonshot', 'z-ai'],
  },
  { path: 'backend/packages/observability-langfuse/', kind: 'vendor', vendors: ['langfuse'] },
  { path: 'backend/packages/observability-otel/', kind: 'vendor', vendors: ['otlp'] },
  { path: 'backend/packages/server/src/auth/GitHubOAuth.ts', kind: 'vendor', vendors: ['github'] },
  { path: 'backend/packages/server/src/auth/GoogleOAuth.ts', kind: 'vendor', vendors: ['google'] },
  { path: 'backend/packages/server/src/auth/LinearOAuth.ts', kind: 'vendor', vendors: ['linear'] },
  { path: 'backend/packages/server/src/auth/oidc/', kind: 'vendor', vendors: ['oidc'] },
  { path: 'backend/packages/server/src/github/', kind: 'vendor', vendors: ['github'] },
  {
    path: 'backend/packages/server/src/modules/llmProxy/',
    kind: 'vendor',
    vendors: ['openai-compatible'],
  },
  {
    path: 'backend/packages/server/src/modules/toolServers/mcpProbe.ts',
    kind: 'vendor',
    vendors: ['mcp'],
  },
  {
    path: 'backend/packages/server/src/modules/webSearch/',
    kind: 'vendor',
    vendors: ['brave-search', 'searxng'],
  },
  { path: 'backend/runtimes/local/src/github.ts', kind: 'vendor', vendors: ['github'] },
  { path: 'backend/runtimes/local/src/linkRepo.ts', kind: 'vendor', vendors: ['github'] },
  { path: 'scripts/check-release-versions.mjs', kind: 'vendor', vendors: ['npm-registry'] },

  // ---- SDK-mediated, a dependency bump rather than a sweep ---------------------------------
  {
    path: 'backend/packages/agents/src/providers/resolvers.ts',
    kind: 'sdk',
    reason:
      'builds the @ai-sdk/* provider clients and hands them a transport; the SDK owns the wire shape (the HOSTS it is pointed at are swept, in providers/endpoints.ts)',
  },

  // ---- our own surfaces, excluded ---------------------------------------------------------
  {
    path: 'backend/internal/conformance/',
    kind: 'internal',
    reason:
      'runtime-neutral assertions against fakes the suite stands up; a host here is a fixture',
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
    path: 'backend/packages/acceptance-kit/',
    kind: 'internal',
    reason:
      "a deployment's own GET /health and GET /auth/config, plus /api/v1 through the published SDK",
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
    path: 'backend/packages/integrations/src/modules/observability/RegistryReleaseHealthProvider.ts',
    kind: 'internal',
    reason:
      'builds the per-vendor release-health adapter from a decrypted connection and forwards the transport; each vendor path is swept in its own module',
  },
  {
    path: 'backend/packages/integrations/src/modules/providers/LocalModelEndpointService.ts',
    kind: 'internal',
    reason:
      "a model endpoint on the user's OWN machine, constrained to the loopback allow-list; no vendor page settles what they run there",
  },
  {
    path: 'backend/packages/integrations/src/modules/providers/UserSecretService.ts',
    kind: 'internal',
    reason:
      "forwards a transport to a secret kind's testConnection; the vendor paths are in userSecretKinds.ts",
  },
  {
    path: 'backend/packages/integrations/src/modules/providers/localModelUrl.ts',
    kind: 'internal',
    reason: 'the loopback-only SSRF policy for a local-runner base URL, plus its redirect walk',
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
    path: 'backend/runtimes/cloudflare/src/infrastructure/observability/',
    kind: 'internal',
    reason:
      'installs and drains the exporters from observability-otel (swept there); holds no vendor path of its own',
  },
  {
    path: 'backend/runtimes/local/src/LocalContainerRunnerTransport.ts',
    kind: 'internal',
    reason: 'the local run container this process just started',
  },
  {
    path: 'backend/runtimes/local/src/LocalPreviewTransport.ts',
    kind: 'internal',
    reason: 'the local preview container this process just started',
  },
  {
    path: 'backend/runtimes/local/src/LocalProcessRunnerTransport.ts',
    kind: 'internal',
    reason: 'the native harness process this facade spawned, over loopback',
  },
  {
    path: 'backend/runtimes/local/src/harnessHttp.ts',
    kind: 'internal',
    reason: 'the run container this process just dispatched',
  },
  {
    path: 'backend/runtimes/local/src/harnessVersion.ts',
    kind: 'internal',
    reason: 'the version handshake with that same harness',
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
    path: 'backend/runtimes/node/src/logExport.ts',
    kind: 'internal',
    reason: 'installs the OTLP log exporter from observability-otel (swept there)',
  },
  {
    path: 'frontend/app/',
    kind: 'internal',
    reason: 'the SPA reaches our own /api/v1 only; no browser code holds a vendor credential',
  },
  {
    path: 'sdk/',
    kind: 'internal',
    reason:
      "the four published clients and their MCP/gatekeeper projections reach a deployment's own /api/v1; the Python, Go and Java transports are hand-written and outside this walk, which is why this entry argues rather than derives",
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

const sourceOf = new Map()
const readSource = (file) => {
  if (!sourceOf.has(file)) sourceOf.set(file, readFileSync(join(root, file), 'utf8'))
  return sourceOf.get(file)
}

/** Each candidate with the direction it arrived from, so `--list` can say which. */
const candidates = sourceFiles()
  .map((file) => {
    const source = readSource(file)
    const call = makesOutboundCall(source)
    const declares = declaresVendorEndpoint(source)
    if (!call && !declares) return null
    return { file, signal: call && declares ? 'call+endpoint' : call ? 'call' : 'endpoint' }
  })
  .filter(Boolean)
  .sort((a, b) => a.file.localeCompare(b.file))

const files = candidates.map((candidate) => candidate.file)
const malformed = malformedEntries(CLASSIFICATION)
const unclassified = unclassifiedFiles(files, CLASSIFICATION)
const unmatched = unmatchedEntries(files, CLASSIFICATION)
const evidenceGaps = vendorEvidenceGaps(files, CLASSIFICATION, readSource)
const drifted = malformed.length + unclassified.length + unmatched.length + evidenceGaps.length > 0

// `--list` is what the sweep reads INSTEAD of re-deriving the inventory by hand, so it emits the
// attribution a record's `Vendor | API + version | Call sites` table needs, not bare paths a
// reader would have to go back to the map for. It runs the checks too: a listing printed off a
// broken map is the one thing worse than no listing, and exiting 0 before them made `--list` a way
// to pass this guard.
const listing = process.argv.includes('--list')
if (listing) {
  console.log('# kind\tvendors\tsignal\thosts\tpath')
  for (const { file, signal } of candidates) {
    const entry = classificationFor(file, CLASSIFICATION)
    const vendors = entry?.vendors?.join(',') ?? '-'
    const hosts = vendorEndpointHosts(readSource(file)).join(',') || '-'
    console.log(`${entry?.kind ?? 'UNCLASSIFIED'}\t${vendors}\t${signal}\t${hosts}\t${file}`)
  }
}

if (!drifted) {
  const vendors = sweptVendors(CLASSIFICATION)
  const summary =
    `check-external-api-inventory: ${candidates.length} external surfaces, all classified ` +
    `(${vendors.length} vendors swept: ${vendors.join(', ')}).`
  // Commented in list mode so the summary cannot be read as a row by whoever parses the columns.
  console.log(listing ? `# ${summary}` : summary)
  process.exit(0)
}

for (const fault of malformed) {
  console.error(`check-external-api-inventory: malformed entry, ${fault}`)
}
for (const file of unclassified) {
  console.error(
    `check-external-api-inventory: ${file} reaches an external API and is classified nowhere.`,
  )
}
for (const path of unmatched) {
  console.error(
    `check-external-api-inventory: the entry for ${path} matches no call site or endpoint declaration; it has moved or gone.`,
  )
}
for (const gap of evidenceGaps) {
  console.error(`check-external-api-inventory: ${gap}`)
}
console.error(
  '\nAdd each to CLASSIFICATION in scripts/check-external-api-inventory.mjs: kind "vendor" with ' +
    'the vendor whose docs settle it (the external-api-sweep skill then verifies it), kind ' +
    '"internal" with the reason no vendor page can make it wrong, or kind "sdk" with the ' +
    'dependency that owns the wire shape.',
)
process.exit(1)
