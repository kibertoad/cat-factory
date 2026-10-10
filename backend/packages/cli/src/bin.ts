#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ArgError, HELP_TEXT, parseArgs } from './args.js'
import { bootstrap } from './bootstrap.js'
import { generateEnv } from './envCommand.js'
// Kernel's describer, COPIED into this package rather than imported: `@cat-factory/kernel` is a
// devDependency here and this file is the published `bin`, so a runtime import would resolve
// through pnpm's workspace link locally and fail with ERR_MODULE_NOT_FOUND off the registry.
import { getErrorMessage } from './errorText.js'
import { setupK3s } from './k3s.js'
import { supervise } from './superviseCommand.js'

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
  if (options.command === 'env') {
    await generateEnv(options)
    return
  }
  if (options.command === 'k3s') {
    await setupK3s(options)
    return
  }
  if (options.command === 'supervise') {
    await supervise(options)
    return
  }

  await bootstrap(options)
}

main().catch((err: unknown) => {
  // An error that describes itself as nothing (an empty message with no cause) says so as an
  // empty string, so the fallback is what stops the last line of a failed run being a bare prefix.
  process.stderr.write(
    `\ncat-factory: ${getErrorMessage(err) || 'failed for an unreported reason'}\n`,
  )
  process.exit(1)
})
