#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { writeRunArtifacts } from './artifacts'
import { type BenchmarkConfig, loadConfig } from './config'
import { buildReport } from './report'
import { runBenchmark } from './run'
import type { TaskType } from './types'

// Thin CLI over the library. Two commands:
//   cat-bench run   --config <path> [--task <t>] [--name <id>] [--out <dir>]
//   cat-bench grade --out <run-dir>
// `run` executes the matrix and writes candidate + grading artifacts (graded by
// the benchmark-arbiter Claude skill); `grade` folds grades.json into the report.

interface Flags {
  _: string[]
  [key: string]: string | boolean | string[]
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      flags._.push(arg)
    }
  }
  return flags
}

function slugTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

/**
 * Walk up from `start` to the git repo root so a default, relative `outDir`
 * (docs/benchmarks) always lands at the repo root — pnpm runs the script with
 * cwd set to the package directory, so `process.cwd()` is not the repo root.
 */
function repoRoot(start: string = process.cwd()): string {
  let dir = start
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

function resolveRunDir(config: BenchmarkConfig, runId: string, out?: string): string {
  if (out) return isAbsolute(out) ? out : resolve(process.cwd(), out)
  const base = config.outDir ?? 'docs/benchmarks'
  return isAbsolute(base) ? join(base, runId) : resolve(repoRoot(), base, runId)
}

async function cmdRun(flags: Flags): Promise<void> {
  const configPath = flags.config as string | undefined
  if (!configPath) throw new Error('run: --config <path> is required')
  const config = await loadConfig(resolve(process.cwd(), configPath))
  if (flags.task && flags.task !== 'all') config.tasks = [flags.task as TaskType]

  const runId = (flags.name as string | undefined) ?? config.name ?? `run-${slugTimestamp()}`
  const outDir = resolveRunDir(config, runId, flags.out as string | undefined)
  await mkdir(outDir, { recursive: true })

  console.error(`cat-bench: running matrix → ${outDir}`)
  const results = await runBenchmark({ config, log: (m) => console.error(`  ${m}`) })
  await writeRunArtifacts({ outDir, runId, config, results, log: (m) => console.error(m) })
  await buildReport(outDir, runId)

  const failed = results.filter((r) => r.error).length
  console.error(
    `cat-bench: ${results.length} cell(s) run (${failed} failed). Grade with:\n` +
      `  /benchmark-arbiter ${outDir}\n` +
      `then: cat-bench grade --out ${outDir}`,
  )
}

async function cmdGrade(flags: Flags): Promise<void> {
  const out = flags.out as string | undefined
  if (!out) throw new Error('grade: --out <run-dir> is required')
  const outDir = isAbsolute(out) ? out : resolve(process.cwd(), out)
  const runId = (flags.name as string | undefined) ?? outDir.split('/').pop() ?? 'run'
  const rows = await buildReport(outDir, runId)
  const graded = rows.filter((r) => typeof r.score === 'number').length
  console.error(`cat-bench: merged grades → report.md (${graded}/${rows.length} graded)`)
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2))
  const command = flags._[0]
  switch (command) {
    case 'run':
      await cmdRun(flags)
      break
    case 'grade':
      await cmdGrade(flags)
      break
    default:
      console.error(
        'Usage:\n' +
          '  cat-bench run   --config <path> [--task all|requirement-review|code-review|implementation] [--name <id>] [--out <dir>]\n' +
          '  cat-bench grade --out <run-dir>',
      )
      process.exitCode = command ? 1 : 0
  }
}

main().catch((err) => {
  console.error(`cat-bench: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
