#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ArgError, HELP_TEXT, parseArgs } from './args.js'
import { bootstrap } from './bootstrap.js'

function readVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

async function main(): Promise<void> {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(`${err.message}\n\n${HELP_TEXT}`)
      process.exit(2)
    }
    throw err
  }

  if (options.command === 'help') {
    process.stdout.write(HELP_TEXT)
    return
  }
  if (options.command === 'version') {
    process.stdout.write(`${readVersion()}\n`)
    return
  }

  await bootstrap(options)
}

main().catch((err: unknown) => {
  process.stderr.write(`\ncat-factory: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
