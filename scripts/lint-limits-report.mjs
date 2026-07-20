#!/usr/bin/env node
// Floor-finder for the oxlint complexity/size ratchet (docs/initiatives/lint-complexity-size-ratchet.md).
//
// The initiative walks each oxlint complexity/size `max` DOWN toward an industry-reasonable
// target, one slice at a time. To plan a slice you need two numbers per rule: the live ceiling
// in `.oxlintrc.json`, and the actual FLOOR — the current worst offender's count, i.e. the
// lowest `max` the tree passes at today without any refactor. This script measures that floor
// (and lists the offenders you'd have to split to go below it) so a slice is a data-driven
// pick, not a guess.
//
// It runs oxlint ONCE with every ratcheted rule forced to `max: 0`, so every function/file that
// the rule can count reports a diagnostic carrying its count; we group by rule, take the max as
// the floor, and surface the top offenders above the reasonable target.
//
// Usage:
//   node scripts/lint-limits-report.mjs            # table for every ratcheted rule
//   node scripts/lint-limits-report.mjs --json     # machine-readable (floor + offenders per rule)
//   node scripts/lint-limits-report.mjs --top 15   # show N worst offenders per rule (default 8)
//
// This is a REPORTING tool, not a CI guard — it never fails the build. The enforcement is the
// live ceilings in `.oxlintrc.json`; this just tells you how far each one can move next.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// The ratcheted rules, paired with the reasonable end-state target from the initiative tracker.
// Keep this list in step with `.oxlintrc.json`'s `rules` block and the tracker's baseline table.
const RULES = [
  { name: 'complexity', target: 20 },
  { name: 'max-statements', target: 30 },
  { name: 'max-lines-per-function', target: 150 },
  { name: 'max-lines', target: 1500 },
  { name: 'max-params', target: 6 },
  { name: 'max-depth', target: 4 },
  { name: 'max-nested-callbacks', target: 4 },
]

function parseArgs(argv) {
  const opts = { json: false, top: 8 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') opts.json = true
    else if (arg === '--top') opts.top = Number(argv[++i]) || opts.top
  }
  return opts
}

// Every ratcheted rule states its count inside the first `(N)` of its message, EXCEPT
// `complexity`, which phrases it as "…has a complexity of N.". Handle both.
function extractCount(message) {
  const paren = message.match(/\((\d+)\)/)
  if (paren) return Number(paren[1])
  const complexity = message.match(/complexity of (\d+)/)
  if (complexity) return Number(complexity[1])
  return null
}

function ruleFromCode(code) {
  // code looks like "eslint(complexity)" / "eslint(max-lines-per-function)".
  const match = code?.match(/\(([^)]+)\)/)
  return match ? match[1] : null
}

// Read the live ceilings so the report can show ceiling → floor → target headroom.
function readCeilings() {
  const config = JSON.parse(readFileSync(join(repoRoot, '.oxlintrc.json'), 'utf8'))
  const ceilings = {}
  for (const [name, value] of Object.entries(config.rules ?? {})) {
    if (Array.isArray(value) && value[1] && typeof value[1].max === 'number') {
      ceilings[name] = value[1].max
    }
  }
  return ceilings
}

// One oxlint run with every ratcheted rule pinned at `max: 0` — the base config's
// `plugins`/`ignorePatterns`/`env` are mirrored so the file set matches a real lint.
function runProbe() {
  const base = JSON.parse(readFileSync(join(repoRoot, '.oxlintrc.json'), 'utf8'))
  const rules = {}
  for (const { name } of RULES) rules[name] = ['error', { max: 0 }]
  const probe = {
    $schema: base.$schema,
    plugins: base.plugins,
    // No `categories` — we want ONLY the ratcheted rules to fire, not the whole correctness set.
    rules,
    ignorePatterns: base.ignorePatterns,
    env: base.env,
  }

  const dir = mkdtempSync(join(tmpdir(), 'lint-limits-'))
  const configPath = join(dir, 'probe.oxlintrc.json')
  writeFileSync(configPath, JSON.stringify(probe))
  try {
    let stdout = ''
    try {
      stdout = execFileSync(
        join(repoRoot, 'node_modules/.bin/oxlint'),
        ['--config', configPath, '--format', 'json', '.'],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      )
    } catch (err) {
      // oxlint exits non-zero when it finds lint errors — which is exactly the probe's purpose.
      // The JSON report is still on stdout; only a missing report is a real failure.
      stdout = err.stdout ?? ''
      if (!stdout) throw err
    }
    return JSON.parse(stdout).diagnostics ?? []
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function collect(diagnostics) {
  const byRule = new Map()
  for (const { name } of RULES) byRule.set(name, new Map()) // rule -> (offenderKey -> {file,line,count})
  for (const diag of diagnostics) {
    const rule = ruleFromCode(diag.code)
    if (!byRule.has(rule)) continue
    const count = extractCount(diag.message)
    if (count == null) continue
    const label = diag.labels?.[0]?.span
    const key = `${diag.filename}:${label?.line ?? 0}`
    const existing = byRule.get(rule).get(key)
    // A file/function can surface several diagnostics (e.g. one per over-limit statement); keep
    // the highest count reported for a given site.
    if (!existing || count > existing.count) {
      byRule.get(rule).set(key, { file: diag.filename, line: label?.line ?? 0, count })
    }
  }
  return byRule
}

function buildReport(byRule, ceilings) {
  return RULES.map(({ name, target }) => {
    const offenders = [...byRule.get(name).values()].sort((a, b) => b.count - a.count)
    const floor = offenders[0]?.count ?? 0
    const ceiling = ceilings[name] ?? null
    // Offenders that block reaching the reasonable target (what a future slice must split).
    const aboveTarget = offenders.filter((o) => o.count > target)
    return {
      rule: name,
      ceiling,
      floor,
      target,
      offendersAboveTarget: aboveTarget.length,
      offenders,
    }
  })
}

function printTable(report, top) {
  const pad = (str, width) => String(str).padEnd(width)
  const padNum = (str, width) => String(str).padStart(width)
  console.log('oxlint ratchet — ceiling (live) vs floor (worst offender) vs target (end state)\n')
  console.log(
    `${pad('rule', 24)} ${padNum('ceiling', 8)} ${padNum('floor', 7)} ${padNum('target', 7)} ${padNum('>target', 8)}`,
  )
  console.log('-'.repeat(24 + 1 + 8 + 1 + 7 + 1 + 7 + 1 + 8))
  for (const row of report) {
    console.log(
      `${pad(row.rule, 24)} ${padNum(row.ceiling ?? '-', 8)} ${padNum(row.floor, 7)} ${padNum(row.target, 7)} ${padNum(row.offendersAboveTarget, 8)}`,
    )
  }
  console.log(
    '\nfloor = the lowest `max` the tree passes at today (drop the ceiling here for free).',
  )
  console.log(
    '>target = offenders still above the end-state target (each must be split to reach it).\n',
  )

  for (const row of report) {
    if (row.offenders.length === 0) continue
    console.log(`### ${row.rule} — top ${Math.min(top, row.offenders.length)} offenders`)
    for (const o of row.offenders.slice(0, top)) {
      console.log(`  ${padNum(o.count, 5)}  ${o.file}:${o.line}`)
    }
    console.log('')
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const ceilings = readCeilings()
  const diagnostics = runProbe()
  const byRule = collect(diagnostics)
  const report = buildReport(byRule, ceilings)

  if (opts.json) {
    const trimmed = report.map((row) => ({
      ...row,
      offenders: row.offenders.slice(0, opts.top),
    }))
    console.log(JSON.stringify(trimmed, null, 2))
    return
  }
  printTable(report, opts.top)
}

main()
