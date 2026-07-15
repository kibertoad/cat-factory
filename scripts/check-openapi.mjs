// CI drift guard for the generated OpenAPI document (twin of `scripts/generate-openapi.mjs`).
// Regenerates the spec in memory and diffs it against the committed `docs/openapi.json`;
// on drift it fails with a GitHub `::error::` annotation telling the dev to regenerate.
// Mirrors `scripts/check-runner-image-tag.mjs` / `check-package-catalog.mjs`.
//
// Prereq: the contracts package must be built first (`pnpm build`).

import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildOpenApiDoc, OPENAPI_PATH, serializeOpenApiDoc } from './generate-openapi.mjs'

async function main() {
  const expected = serializeOpenApiDoc(await buildOpenApiDoc())
  let committed
  try {
    committed = await readFile(OPENAPI_PATH, 'utf8')
  } catch {
    committed = null
  }
  const rel = relative(process.cwd(), OPENAPI_PATH)
  if (committed === null) {
    console.error(`::error file=${rel}::${rel} is missing. Run \`pnpm gen:openapi\` and commit it.`)
    process.exit(1)
  }
  if (committed !== expected) {
    console.error(
      `::error file=${rel}::${rel} is out of date with the API contracts. Run \`pnpm gen:openapi\` and commit the result.`,
    )
    process.exit(1)
  }
  console.log(`${rel} is up to date.`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
