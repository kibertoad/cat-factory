// CI drift guard for the generated OpenAPI document (twin of `scripts/generate-openapi.mjs`).
// Regenerates the spec in memory and diffs it against BOTH committed copies — `docs/openapi.json`
// and the TS module the deployment serves at `GET /api/v1/openapi.json`; on drift it fails with a
// GitHub `::error::` annotation telling the dev to regenerate.
// Mirrors `scripts/check-runner-image-tag.mjs` / `check-package-catalog.mjs`.
//
// Both copies are checked rather than only the canonical one, because a SERVED spec that lags the
// contracts is worse than an absent one: a third-party client generated from it fails against the
// very deployment that handed it over.
//
// Prereq: the contracts package must be built first (`pnpm build`).

import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildOpenApiDoc,
  OPENAPI_PATH,
  SERVED_OPENAPI_PATH,
  serializeOpenApiDoc,
  serializeServedOpenApiDoc,
} from './generate-openapi.mjs'

/**
 * Compare one committed artifact against what the generator would write now.
 *
 * An ABSENT file and an unreadable one get different messages, because they need different fixes and
 * only one of them is the dev's: `pnpm gen:openapi` writes a file that is missing and does nothing
 * at all for a permission error or a truncated checkout. Collapsing the two sent a reader to
 * regenerate, see no change, and distrust the guard.
 */
async function checkArtifact(path, expected) {
  const rel = relative(process.cwd(), path)
  let committed
  try {
    committed = await readFile(path, 'utf8')
  } catch (error) {
    console.error(
      error?.code === 'ENOENT'
        ? `::error file=${rel}::${rel} is missing. Run \`pnpm gen:openapi\` and commit it.`
        : `::error file=${rel}::${rel} could not be read (${error?.code ?? error?.message}). ` +
            'This is not a drift failure: the file exists but this process cannot read it.',
    )
    return false
  }
  if (committed !== expected) {
    console.error(
      `::error file=${rel}::${rel} is out of date with the API contracts. Run \`pnpm gen:openapi\` and commit the result.`,
    )
    return false
  }
  console.log(`${rel} is up to date.`)
  return true
}

async function main() {
  const doc = await buildOpenApiDoc()
  // Both are reported before exiting rather than short-circuiting on the first: one regeneration
  // fixes them together, so a partial report would read as a partial fix.
  const results = [
    await checkArtifact(OPENAPI_PATH, serializeOpenApiDoc(doc)),
    await checkArtifact(SERVED_OPENAPI_PATH, serializeServedOpenApiDoc(doc)),
  ]
  if (results.some((ok) => !ok)) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
