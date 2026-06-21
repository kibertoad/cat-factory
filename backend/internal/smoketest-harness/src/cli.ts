#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { writeRunArtifacts } from './artifacts'
import { type SmoketestConfig, loadConfig } from './config'
import { runSmoketests } from './run'

// Thin CLI over the library. One command:
//   cat-smoke run --config <path> [--fixture <id>] [--name <id>] [--out <dir>] [--relax-guard]
// It runs the matrix through the real Pi setup, captures every transcript, and
// writes the analysis under docs/smoketests/<run-id>/. There is NO grade step —
// the analysis is deterministic and written inline. Run locally with a configured
// Cloudflare account; never in CI.

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
 * (docs/smoketests) always lands at the repo root — pnpm runs the script with cwd
 * set to the package directory, so `process.cwd()` is not the repo root.
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

function resolveRunDir(config: SmoketestConfig, runId: string, out?: string): string {
  if (out) return isAbsolute(out) ? out : resolve(process.cwd(), out)
  const base = config.outDir ?? 'docs/smoketests'
  return isAbsolute(base) ? join(base, runId) : resolve(repoRoot(), base, runId)
}

async function cmdRun(flags: Flags): Promise<void> {
  const configPath = flags.config as string | undefined
  if (!configPath) throw new Error('run: --config <path> is required')
  const config = await loadConfig(resolve(process.cwd(), configPath))
  if (flags.fixture && flags.fixture !== 'all') config.fixtures = [flags.fixture as string]
  if (flags['relax-guard']) config.relaxGuard = true

  const runId = (flags.name as string | undefined) ?? config.name ?? `run-${slugTimestamp()}`
  const outDir = resolveRunDir(config, runId, flags.out as string | undefined)
  await mkdir(outDir, { recursive: true })

  console.error(`cat-smoke: running matrix → ${outDir}`)
  const outputs = await runSmoketests({ config, log: (m) => console.error(`  ${m}`) })
  const manifest = await writeRunArtifacts({
    outDir,
    runId,
    config,
    outputs,
    log: (m) => console.error(m),
  })

  const { healthy, degraded, broken } = manifest.verdicts
  console.error(
    `cat-smoke: ${manifest.caseCount} case(s) — ` +
      `✅ ${healthy} healthy · ⚠️ ${degraded} degraded · ❌ ${broken} broken\n` +
      `  report: ${join(outDir, 'report.md')}`,
  )
  if (broken > 0) process.exitCode = 1
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2))
  const command = flags._[0]
  switch (command) {
    case 'run':
      await cmdRun(flags)
      break
    default:
      console.error(
        'Usage:\n' +
          '  cat-smoke run --config <path> [--fixture all|<id>] [--name <id>] [--out <dir>] [--relax-guard]',
      )
      process.exitCode = command ? 1 : 0
  }
}

main().catch((err) => {
  console.error(`cat-smoke: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
