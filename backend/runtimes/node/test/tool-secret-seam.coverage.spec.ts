import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The capability-credential resolver seam must stay THREADED from the facade's option bag to the
// container executor.
//
// This is a structural guard because the failure it catches is structural and silent. Every link
// in the chain is an OPTIONAL field, so a refactor that drops one still typechecks, still passes
// every behavioural test, and leaves the deployment quietly running the env-backed default while
// its option is accepted and ignored — the shape of "a documented lever nobody can pull", which is
// exactly the defect this seam was added to remove.
//
// Its Worker twin is `runtimes/cloudflare/test/tool-secret-seam.coverage.test.ts`. The two facades
// serve the same app behind the same port, so the seam is a parity concern rather than a per-
// runtime one; before it existed the conformance suite noted that both facades were symmetric "by
// construction" because both called `createEnvToolSecretResolver` directly, and these two tests
// are what replaces that construction.

const SOURCES = {
  // The option a deployment sets.
  'src/container-options.ts': [/createToolSecretResolver\?: \(env: NodeJS\.ProcessEnv\)/],
  // `start()` forwarding it onto the options object it builds the container from — the local
  // facade rides this same field.
  'src/server.ts': [/createToolSecretResolver: options\.createToolSecretResolver/],
  // The composition root calling the factory with this process's env and handing the result to
  // the executor.
  'src/container-run-platform.ts': [/options\.createToolSecretResolver\(env\)/],
  // The executor preferring an injected resolver over the env-backed default.
  'src/container-executor-deps.ts': [
    /resolveToolSecrets: resolveToolSecrets \?\? createEnvToolSecretResolver/,
  ],
}

describe('the tool-secret resolver seam reaches the container executor', () => {
  it('is threaded through every link of the Node facade', async () => {
    const missing: string[] = []
    for (const [file, patterns] of Object.entries(SOURCES)) {
      const source = await readFile(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')
      for (const pattern of patterns) {
        if (!pattern.test(source)) missing.push(`${file}: ${pattern}`)
      }
    }
    expect(missing).toEqual([])
  })
})
