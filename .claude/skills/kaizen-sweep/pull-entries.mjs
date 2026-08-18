#!/usr/bin/env node
// Pull one sweep's worth of Kaizen entries off a deployment's public API (`/api/v1/kaizen/entries`)
// and write them to a JSON file for the sweep to read. Companion of `.claude/skills/kaizen-sweep`.
//
// It exists so the mechanical half of a sweep is not retyped as curl each time: reading the
// credential out of a `.env`, following the keyset cursor to the end, splitting settled entries
// from in-flight ones, and reporting what it did NOT read.
//
// Three rules it holds, each of which is a silent wrong answer when broken:
//
//  1. **The key is never printed and never written to the output.** It is read, sent in one
//     header, and dropped. The output file carries model-authored prose and is meant to be read,
//     pasted and diffed; a credential in it would travel with every one of those.
//  2. **A cap states what it dropped.** Paging stops at `--max-pages`, and when it does the output
//     says so and carries the cursor to resume from. A truncated pull that looked complete would
//     put "nothing new" in a tracker whose backlog was never reached.
//  3. **In-flight entries are READ but never filed.** The backlog query the loop wants is
//     `settled=true`, and this pulls without it on purpose: an entry still being graded is what
//     stops the tracker's ledger from advancing a watermark past rows that have not been written
//     yet. They are counted, reported, and left out of `entries`.
//
// Usage:
//   node .claude/skills/kaizen-sweep/pull-entries.mjs --env <path/to/.env> [options]
//
//   --env <path>          Required. `.env` holding CAT_FACTORY_BASE_URL and CAT_FACTORY_API_KEY.
//   --out <path>          Where to write the JSON. Default: a timestamped file in the temp dir.
//   --since <epochMs>     Only entries created at or after this stamp (the ledger's watermark).
//   --agent-kind <kind>   Only entries grading this agent kind.
//   --acknowledged <v>    `false` (default), `true`, or `all`.
//   --limit <n>           Page size, 1..100. Default 100.
//   --max-pages <n>       Page ceiling. Default 100 (10,000 entries at the default limit).
//
// Exit codes: 0 pulled (possibly truncated, which the output states), 1 refused or unreachable.

import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FLAGS = {
  env: 'env',
  out: 'out',
  since: 'since',
  'agent-kind': 'agentKind',
  acknowledged: 'acknowledged',
  limit: 'limit',
  'max-pages': 'maxPages',
}

/** Parse `--flag value` pairs, refusing an unknown flag rather than ignoring it. */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS[String(argv[i]).replace(/^--/, '')]
    if (!key)
      fail(
        `Unknown argument '${argv[i]}'. Known: ${Object.keys(FLAGS)
          .map((f) => `--${f}`)
          .join(', ')}`,
      )
    if (argv[i + 1] === undefined) fail(`--${argv[i].replace(/^--/, '')} needs a value`)
    out[key] = argv[i + 1]
  }
  return out
}

function fail(message) {
  console.error(`kaizen-sweep: ${message}`)
  process.exit(1)
}

/**
 * Read `KEY=value` pairs out of a dotenv file. Deliberately minimal: `export ` prefixes, `#`
 * comments, blank lines and one layer of surrounding quotes, which is every shape the acceptance
 * suite's own `.env` writer produces. A value it cannot parse is left out rather than guessed at,
 * so a malformed file is reported as a missing variable instead of a truncated key.
 */
function readEnvFile(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    fail(`cannot read ${path}: ${describe(error)}`)
  }
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match || line.trimStart().startsWith('#')) continue
    const raw = match[2].trim()
    const quoted = /^(['"])([\s\S]*)\1$/.exec(raw)
    values[match[1]] = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').trim()
  }
  return values
}

/**
 * The whole cause chain of a thrown value, because on Node a transport failure's own message is
 * the contentless `fetch failed`: identical for an unreachable host, a bad certificate and a DNS
 * typo. Same rule the repo's kernel holds for its own error describers.
 */
function describe(error) {
  const parts = []
  let current = error
  while (current && parts.length < 5) {
    const message = current instanceof Error ? current.message : String(current)
    if (message && !parts.includes(message)) parts.push(message)
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(': ') || 'unknown error'
}

/** One authenticated GET, with the refusal translated into what the operator has to change. */
async function get(baseUrl, apiKey, path) {
  let response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    })
  } catch (error) {
    fail(`GET ${path} could not reach ${baseUrl}: ${describe(error)}`)
  }
  if (response.ok) return response.json()
  const body = await response.text().catch(() => '')
  const reason = readReason(body)
  fail(
    `GET ${path} answered ${response.status}${reason ? ` (${reason})` : ''}. ${remedyFor(response.status, reason)}`,
  )
}

function readReason(body) {
  try {
    const parsed = JSON.parse(body)
    return parsed?.error?.details?.reason ?? parsed?.error?.code ?? ''
  } catch {
    return ''
  }
}

/** What the operator does about each refusal this surface can answer with. */
function remedyFor(status, reason) {
  if (status === 401)
    return 'The key was rejected: check CAT_FACTORY_API_KEY in the .env, and that it has not been revoked.'
  if (status === 403) return "The key is valid but too narrow: reading entries needs 'read' scope."
  if (status === 503 && reason === 'public_api_unconfigured')
    return 'This deployment has not wired the public API.'
  if (status === 503)
    return 'This deployment has not wired the Kaizen module, so it has no entries to sweep.'
  if (status === 400)
    return 'The request was refused before any lookup; a stale --since or cursor is the usual cause.'
  return 'Unexpected refusal; the response body above names the cause.'
}

/** The query string for one page, built from the resolved options. */
function pageQuery(options, cursor) {
  const params = new URLSearchParams({ limit: String(options.limit) })
  if (cursor) params.set('cursor', cursor)
  if (options.acknowledged !== 'all') params.set('acknowledged', options.acknowledged)
  if (options.agentKind) params.set('agentKind', options.agentKind)
  if (options.since !== undefined) params.set('since', String(options.since))
  return `/api/v1/kaizen/entries?${params.toString()}`
}

/** Follow the keyset cursor to the end, or to the page ceiling, whichever comes first. */
async function pullAll(baseUrl, apiKey, options) {
  const entries = []
  let cursor
  let pages = 0
  do {
    const page = await get(baseUrl, apiKey, pageQuery(options, cursor))
    entries.push(...page.entries)
    cursor = page.nextCursor
    pages += 1
  } while (cursor && pages < options.maxPages)
  return { entries, pages, truncated: Boolean(cursor), resumeCursor: cursor ?? null }
}

const SETTLED = new Set(['complete', 'failed'])

/**
 * What the sweep needs to know before it reads a single entry, computed here rather than counted
 * by hand afterwards. `noFinding` is a real category and not an absence: an entry the grader had
 * nothing to say about still has to enter the ledger, or the next sweep re-reads and re-judges it.
 */
function summarise(entries) {
  const settled = entries.filter((e) => SETTLED.has(e.status))
  const withRecommendations = settled.filter((e) => e.recommendations.length > 0)
  return {
    read: entries.length,
    settled: settled.length,
    inFlight: entries.length - settled.length,
    failed: settled.filter((e) => e.status === 'failed').length,
    withRecommendations: withRecommendations.length,
    noFinding: settled.length - withRecommendations.length,
    verifiedCombo: withRecommendations.filter((e) => e.combo?.verified === true).length,
    workspaceOrVariantPrompt: withRecommendations.filter((e) => /\|[vw]/.test(e.comboKey)).length,
    oldestUnsettledCreatedAt: entries
      .filter((e) => !SETTLED.has(e.status))
      .reduce((min, e) => (min === null ? e.createdAt : Math.min(min, e.createdAt)), null),
  }
}

function resolveOptions(args) {
  const limit = Number(args.limit ?? 100)
  const maxPages = Number(args.maxPages ?? 100)
  const acknowledged = args.acknowledged ?? 'false'
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    fail('--limit must be an integer 1..100')
  if (!Number.isInteger(maxPages) || maxPages < 1) fail('--max-pages must be a positive integer')
  if (!['true', 'false', 'all'].includes(acknowledged))
    fail("--acknowledged must be 'true', 'false' or 'all'")
  const since = args.since === undefined ? undefined : Number(args.since)
  if (since !== undefined && !Number.isInteger(since)) fail('--since must be an epoch-ms integer')
  return { limit, maxPages, acknowledged, since, agentKind: args.agentKind }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.env) fail('--env <path to .env> is required')
  const options = resolveOptions(args)

  const env = readEnvFile(args.env)
  const baseUrl = (env.CAT_FACTORY_BASE_URL ?? process.env.CAT_FACTORY_BASE_URL ?? '').replace(
    /\/+$/,
    '',
  )
  const apiKey = env.CAT_FACTORY_API_KEY ?? process.env.CAT_FACTORY_API_KEY
  if (!baseUrl)
    fail(
      `${args.env} sets no CAT_FACTORY_BASE_URL (the backend origin, e.g. https://cat-factory.example.com)`,
    )
  if (!apiKey)
    fail(`${args.env} sets no CAT_FACTORY_API_KEY (a public-API key with at least 'read' scope)`)

  // Identity first: it names the workspace the sweep is about and the scope the key carries, both
  // of which belong in the tracker's sweep log. It also turns a bad key into one clear refusal
  // here rather than an ambiguous one mid-paging.
  const identity = await get(baseUrl, apiKey, '/api/v1/me')
  const pull = await pullAll(baseUrl, apiKey, options)

  const out =
    args.out ??
    join(tmpdir(), `kaizen-sweep-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const report = {
    fetchedAt: new Date().toISOString(),
    baseUrl,
    workspace: {
      workspaceId: identity.workspaceId,
      keyLabel: identity.label,
      scope: identity.scope,
    },
    query: { ...options },
    pages: pull.pages,
    truncated: pull.truncated,
    resumeCursor: pull.resumeCursor,
    counts: summarise(pull.entries),
    // Settled entries only: an in-flight grading has no recommendations to file yet, and filing
    // one would put a half-written judgement in the tracker under a permanent id.
    entries: pull.entries.filter((e) => SETTLED.has(e.status)),
  }
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)

  console.log(
    `workspace ${identity.workspaceId} (key '${identity.label}', scope '${identity.scope}') at ${baseUrl}`,
  )
  console.log(
    `read ${report.counts.read} entries over ${pull.pages} page(s): ` +
      `${report.counts.settled} settled (${report.counts.withRecommendations} with recommendations, ` +
      `${report.counts.noFinding} with none, ${report.counts.failed} failed gradings), ` +
      `${report.counts.inFlight} still being graded`,
  )
  if (pull.truncated) {
    console.log(
      `TRUNCATED at the --max-pages ceiling (${options.maxPages}). Entries older than the last one ` +
        `read were NOT pulled. Say so in the sweep log, then resume with a larger --max-pages.`,
    )
  }
  console.log(`written to ${out}`)
}

await main()
