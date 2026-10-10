#!/usr/bin/env node
// Take swept entries off the deployment's Kaizen backlog, once they are filed in the tracker.
// The OPT-IN closing step of `.claude/skills/kaizen-sweep`: it writes to a live deployment, so it
// runs only when the operator asks for it, and only after the tracker PR exists.
//
// Why it is a separate script rather than a flag on the pull: acknowledging is the one write in
// the whole loop. Keeping it apart means a sweep that goes wrong (a bad theme match, a PR the
// reviewer rejects) has changed nothing on the deployment, and the same entries come back on the
// next pull.
//
// Ordering matters and is not arranged here: file FIRST, acknowledge SECOND. The tracker is what
// carries an entry after this runs; acknowledging before the tracker holds it drops the entry off
// the backlog with nothing recording what it said.
//
// Usage:
//   node .claude/skills/kaizen-sweep/acknowledge-entries.mjs --env <path/to/.env> \
//     --ids <file with one entryId per line> --note "swept into docs/internal/kaizen-tracker.md (PR #NNN)"
//
//   --env <path>    Required. Same `.env` the pull used. The key needs 'write' scope for this.
//   --ids <path>    Required. One entry id per line; blank lines and `#` comments are ignored.
//   --note <text>   Required. What the next reader needs: the tracker item, the PR. Max 2000 chars.
//   --dry-run       Print what would be acknowledged and exit without writing anything.
//
// Exit codes: 0 every id settled (acknowledged or already acknowledged), 1 one or more refused.

import { readFileSync } from 'node:fs'

const NOTE_MAX = 2_000

function fail(message) {
  console.error(`kaizen-sweep: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--env') args.env = argv[++i]
    else if (flag === '--ids') args.ids = argv[++i]
    else if (flag === '--note') args.note = argv[++i]
    else fail(`Unknown argument '${flag}'. Known: --env, --ids, --note, --dry-run`)
  }
  return args
}

function readEnvFile(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
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

function readIds(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const ids = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  if (ids.length === 0) fail(`${path} lists no entry ids`)
  return [...new Set(ids)]
}

/**
 * Acknowledge one entry, translating the two refusals this route can answer with into what they
 * mean for the sweep rather than a bare status.
 *
 * A 409 is TIMING, not an error in the tracker: the grading settled after the pull and the entry
 * belongs to the next sweep. A 404 is identity: the entry is gone, and whatever the tracker
 * recorded about it stands on its own.
 */
async function acknowledgeOne(baseUrl, apiKey, entryId, note) {
  let response
  try {
    response = await fetch(
      `${baseUrl}/api/v1/kaizen/entries/${encodeURIComponent(entryId)}/acknowledge`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ note }),
      },
    )
  } catch (error) {
    return {
      entryId,
      ok: false,
      detail: `unreachable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (response.ok) return { entryId, ok: true, detail: 'acknowledged' }
  const body = await response.text().catch(() => '')
  return {
    entryId,
    ok: false,
    detail: `${response.status} ${describeRefusal(response.status, body)}`,
  }
}

function describeRefusal(status, body) {
  let reason = ''
  try {
    reason = JSON.parse(body)?.error?.details?.reason ?? ''
  } catch {
    reason = ''
  }
  if (status === 403) return "insufficient scope: acknowledging needs a 'write'-scope key"
  if (status === 401) return 'the key was rejected'
  if (reason === 'kaizen_entry_not_settled')
    return 'grading settled after the pull; it belongs to the next sweep'
  if (reason === 'kaizen_entry_not_found') return 'this workspace no longer holds that entry'
  return reason || 'refused'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.env) fail('--env <path to .env> is required')
  if (!args.ids) fail('--ids <file of entry ids> is required')
  if (!args.note)
    fail(
      '--note "<what the next reader needs>" is required: an unattributed acknowledgement is a triage nobody can trace',
    )
  if (args.note.length > NOTE_MAX)
    fail(`--note is ${args.note.length} characters; the surface stores at most ${NOTE_MAX}`)

  const env = readEnvFile(args.env)
  const baseUrl = (env.CAT_FACTORY_BASE_URL ?? process.env.CAT_FACTORY_BASE_URL ?? '').replace(
    /\/+$/,
    '',
  )
  const apiKey = env.CAT_FACTORY_API_KEY ?? process.env.CAT_FACTORY_API_KEY
  if (!baseUrl) fail(`${args.env} sets no CAT_FACTORY_BASE_URL`)
  if (!apiKey) fail(`${args.env} sets no CAT_FACTORY_API_KEY`)

  const ids = readIds(args.ids)
  if (args.dryRun) {
    console.log(`would acknowledge ${ids.length} entries at ${baseUrl} with note: ${args.note}`)
    for (const id of ids) console.log(`  ${id}`)
    return
  }

  const results = []
  for (const entryId of ids) {
    results.push(await acknowledgeOne(baseUrl, apiKey, entryId, args.note))
  }
  const failures = results.filter((r) => !r.ok)
  for (const result of failures) console.error(`  ${result.entryId}: ${result.detail}`)
  console.log(
    `acknowledged ${results.length - failures.length}/${results.length} entries at ${baseUrl}`,
  )
  if (failures.length > 0) {
    console.error(
      'Those entries are still on the deployment backlog. The tracker ledger already holds them, so ' +
        'the next sweep will not re-file them; re-run this step once the cause above is fixed.',
    )
    process.exit(1)
  }
}

await main()
