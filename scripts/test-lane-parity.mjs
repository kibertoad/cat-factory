// Detection for `check-test-lane-parity.mjs`: the three extractors, split out so their behaviour
// is testable in isolation (`scripts/test-lane-parity.test.mjs`). Same split, and for the same
// reason, as `reserved-env-keys.mjs` / `silent-catch.mjs`: a guard nothing tests is a guard that is
// trusted without evidence.
//
// Textual rather than a YAML/JSON-aware walk over the workflow: this guard runs in the
// install-free `repo-guards` job and node ships no YAML parser, so both sides are read the same
// way. Every extractor throws rather than returning empty when its anchor is gone, because an
// empty exclusion list on either side compares EQUAL to an empty one on the other and the guard
// would report green having read nothing.

/**
 * The packages a turbo/pnpm command EXCLUDES, as bare names.
 *
 * Only negative filters count. Both sides of the comparison also carry positive `--filter`
 * arguments (`...[origin/main]`, a single package for a smoke step) and those select scope rather
 * than narrowing infra requirements, which is the thing being kept in step here.
 */
export function excludedPackages(command) {
  const names = new Set()
  for (const match of command.matchAll(/--filter=['"]?!([^'"\s]+)/g)) {
    names.add(match[1])
  }
  return [...names].sort()
}

/**
 * A workflow job's own text block, by job id.
 *
 * Anchored on the JOB rather than on a step's `name:` so renaming the step (prose, freely edited)
 * does not trip the guard, while moving the exclusions to a different job does. The block runs to
 * the next job at the same indentation.
 */
export function workflowJob(workflow, jobId) {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`  ${jobId}:`))
  if (start === -1) {
    throw new Error(
      `could not find the \`${jobId}\` job in the workflow; if the no-DB lane was renamed, ` +
        'update NO_DB_LANE_JOB in check-test-lane-parity.mjs to match',
    )
  }
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^ {2}\S/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/**
 * One `scripts` entry out of a parsed package.json.
 *
 * Throws on an absent script for the same reason the extractors above do: a renamed script would
 * otherwise read as a command with no exclusions, which trivially matches nothing.
 */
export function packageScript(pkg, name) {
  const command = pkg.scripts?.[name]
  if (typeof command !== 'string') {
    throw new Error(
      `the root package.json has no \`${name}\` script; if it was renamed, update ` +
        'check-test-lane-parity.mjs to match',
    )
  }
  return command
}

/** The two-way difference between two sorted name lists. */
export function diffExclusions(script, lane) {
  return {
    onlyInScript: script.filter((name) => !lane.includes(name)),
    onlyInLane: lane.filter((name) => !script.includes(name)),
  }
}
