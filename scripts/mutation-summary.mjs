#!/usr/bin/env node
// Turns a package's Stryker JSON report into one markdown row, so the nightly mutation workflow's
// run page states every package's score in a table instead of hiding it in a job log nobody opens.
//
// The two scores are the standard mutation-testing-elements definitions, computed here rather than
// scraped out of Stryker's console table:
//   score          = detected / (detected + undetected)     ... over EVERY mutant
//   covered score  = detected / (detected + survived)       ... over mutants a test actually ran
// where detected = Killed + Timeout and undetected = Survived + NoCoverage. `Ignored` (this repo
// ignores static mutants), `CompileError` and `RuntimeError` are excluded from both denominators,
// which is what makes the covered-code score the fair read on the tests that exist and the total
// score the honest read on the scope.
//
// Usage: node scripts/mutation-summary.mjs <packageDir> [<packageDir> ...]

import fs from 'node:fs'
import path from 'node:path'

const REPORT = 'reports/mutation/mutation.json'

// `Survived` and `NoCoverage` are counted separately below (the covered-code score needs them
// apart), so only the detected pair needs a set.
const DETECTED = new Set(['Killed', 'Timeout'])

function metricsFor(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const counts = { detected: 0, survived: 0, noCoverage: 0, excluded: 0 }
  for (const file of Object.values(report.files ?? {})) {
    for (const { status } of file.mutants ?? []) {
      if (DETECTED.has(status)) counts.detected += 1
      else if (status === 'Survived') counts.survived += 1
      else if (status === 'NoCoverage') counts.noCoverage += 1
      else counts.excluded += 1
    }
  }
  const undetected = counts.survived + counts.noCoverage
  const valid = counts.detected + undetected
  const covered = counts.detected + counts.survived
  return {
    ...counts,
    valid,
    score: valid === 0 ? null : (counts.detected / valid) * 100,
    coveredScore: covered === 0 ? null : (counts.detected / covered) * 100,
    floor: report.thresholds?.break ?? null,
  }
}

const pct = (value) => (value === null ? 'n/a' : `${value.toFixed(2)}%`)

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('Usage: node scripts/mutation-summary.mjs <packageDir> [<packageDir> ...]')
  process.exit(1)
}

const rows = []
const missing = []
for (const dir of dirs) {
  const reportPath = path.join(dir, REPORT)
  if (!fs.existsSync(reportPath)) {
    missing.push(reportPath)
    continue
  }
  const m = metricsFor(reportPath)
  const belowFloor = m.floor !== null && m.score !== null && m.score < m.floor
  rows.push(
    `| \`${dir}\` | ${m.valid} | ${pct(m.score)} | ${pct(m.coveredScore)} | ${
      m.floor === null ? 'n/a' : `${m.floor}%`
    } | ${belowFloor ? 'BELOW FLOOR' : 'ok'} |`,
  )
}

console.log('| package | mutants | score | covered-code score | floor | |')
console.log('| --- | --: | --: | --: | --: | --- |')
for (const row of rows) console.log(row)

// A report that is not there is not a zero and not a pass: the run crashed, was cancelled, or
// wrote somewhere else, and every one of those needs a human. Say which file was expected and
// fail, rather than printing a table that reads like a package with nothing to report.
if (missing.length > 0) {
  console.log()
  for (const reportPath of missing) console.log(`> No Stryker report at \`${reportPath}\`.`)
  console.error(`Missing Stryker report(s): ${missing.join(', ')}`)
  process.exit(1)
}
